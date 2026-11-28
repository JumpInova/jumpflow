/**
 * Envio agendado de Consultas (ESPECIFICAÇÃO §6 C3) — servidor.
 *
 * Cadastro (tela): exige `CONSULTAS` + `CONSULTAS_AGENDAR`; só o dono altera
 * ou exclui (sem override por papel global); o alvo (visão/painel) precisa
 * estar aberto para quem agenda; destinatários são USUÁRIOS ativos do sistema
 * (nunca e-mail livre). Criar/alterar/excluir são auditados.
 *
 * Execução (job `/api/jobs/consultas-agendadas`):
 * - janela = ocorrência agendada (`schedule.ts`); `ConsultaScheduleRun` é
 *   UNIQUE por (agendamento, janela) → idempotente entre chamadas/instâncias;
 * - claim/lease no banco: só quem cria o run (ou assume um lease vencido / um
 *   FAILED com tentativas sobrando) processa;
 * - roda com a permissão de CADA DESTINATÁRIO (matriz + escopo + Dados
 *   Sensíveis dele): quem não tem acesso à visão/painel/entidade/campo ou não
 *   pode exportar é PULADO e registrado no run. Nunca usa a permissão do
 *   criador para dados — do criador só se exige que ainda possa agendar;
 * - entrega AT-LEAST-ONCE: quem já está registrado como SENT não recebe de
 *   novo numa retentativa/retomada; mas se o processo cair entre o
 *   `transport.send` e a gravação do progresso, aquele destinatário pode
 *   receber o mesmo arquivo outra vez (não há como tornar o envio e a
 *   gravação atômicos com um provedor de e-mail externo).
 */
import { randomUUID } from "node:crypto";
import { prisma, type Prisma } from "@jumpflow/database";
import type { AppUser } from "@/lib/auth/types";
import { recordAuditEvent } from "@/lib/db/audit";
import { loadPermissionMatrixForUser } from "@/lib/db/permissions";
import { mapPersistedRoles, resolveDbUser } from "@/lib/db/users";
import { buildConsultaContext, exportConsulta, getConsultaContext, type ConsultaContext } from "@/lib/db/consultas";
import { getPanelForViewer, getSavedViewForViewer, listPanels, listSavedViews } from "@/lib/db/consultas-saved";
import { CONSULTAS_CODES, matrixAllows } from "@/lib/auth/permission-codes";
import { appConfig } from "@/config/app";
import { getEmailTransport, type EmailTransport } from "@/lib/automation/email-transport";
import { buildConsultaAgendadaEmail } from "@/lib/automation/email/templates";
import { buildWorkbook, type XlsxSheetSpec } from "@/lib/export/xlsx";
import { ConsultaError, isConsultaError } from "@/lib/consultas/errors";
import { canOpenShared, canOpenView, firstIssue, parsePanelItems, specUsableBy, type Viewer } from "@/lib/consultas/saved";
import {
  describeTiming,
  dueOccurrence,
  nextOccurrence,
  normalizeTiming,
  runStatus,
  scheduleInputSchema,
  type RecipientOutcome,
  type ScheduleFrequency,
  type SkipReason,
} from "@/lib/consultas/schedule";
import {
  dataSheet,
  safeFilename,
  totalRows,
  totalsSheet,
  uniqueSheetName,
  type SheetData,
} from "@/lib/consultas/xlsx-sheets";
import type { RoleName } from "@/lib/auth/roles";

const NOT_FOUND_MESSAGE = "Agendamento não encontrado.";
/** Lease do claim: bem acima do maxDuration da rota (300s). */
export const LEASE_MS = 10 * 60_000;
/** Tentativas por janela quando há falha de entrega. */
export const MAX_RUN_ATTEMPTS = 3;
/** Execuções processadas por chamada do job (o resto fica para a próxima). */
export const JOB_BATCH = 20;
/** Página de agendamentos ativos lida por vez (todas as páginas são percorridas). */
const SCHEDULE_PAGE = 500;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/* ───────────────────────────── Cadastro ───────────────────────────── */

export interface ScheduleSummary {
  id: string;
  name: string;
  targetKind: "view" | "panel";
  targetId: string;
  targetName: string;
  frequency: ScheduleFrequency;
  hour: number;
  weekday: number | null;
  monthDay: number | null;
  timing: string;
  recipients: { id: string; name: string }[];
  active: boolean;
  lastRun: { windowKey: string; status: string; sent: number; skipped: number; failed: number } | null;
  nextAt: string | null;
}

const scheduleSelect = {
  id: true,
  ownerId: true,
  name: true,
  viewId: true,
  panelId: true,
  frequency: true,
  hour: true,
  weekday: true,
  monthDay: true,
  recipientUserIds: true,
  active: true,
  activeSince: true,
  view: { select: { name: true } },
  panel: { select: { name: true } },
  runs: {
    orderBy: { startedAt: "desc" as const },
    take: 1,
    select: { windowKey: true, status: true, results: true },
  },
} as const;

type ScheduleRow = {
  id: string;
  ownerId: string;
  name: string;
  viewId: string | null;
  panelId: string | null;
  frequency: ScheduleFrequency;
  hour: number;
  weekday: number | null;
  monthDay: number | null;
  recipientUserIds: string[];
  active: boolean;
  activeSince: Date;
  view: { name: string } | null;
  panel: { name: string } | null;
  runs: { windowKey: string; status: string; results: Prisma.JsonValue }[];
};

function parseOutcomes(raw: unknown): RecipientOutcome[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is RecipientOutcome =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as { userId?: unknown }).userId === "string" &&
      ["SENT", "SKIPPED", "FAILED"].includes((item as { status?: string }).status ?? ""),
  );
}

function toSummary(row: ScheduleRow, users: Map<string, string>, now: Date): ScheduleSummary {
  const timing = normalizeTiming(row);
  const last = row.runs[0];
  const outcomes = last ? parseOutcomes(last.results) : [];
  return {
    id: row.id,
    name: row.name,
    targetKind: row.viewId ? "view" : "panel",
    targetId: (row.viewId ?? row.panelId) as string,
    targetName: row.view?.name ?? row.panel?.name ?? "—",
    frequency: row.frequency,
    hour: row.hour,
    weekday: row.weekday,
    monthDay: row.monthDay,
    timing: describeTiming(timing),
    recipients: row.recipientUserIds.map((id) => ({ id, name: users.get(id) ?? "Usuário removido" })),
    active: row.active,
    lastRun: last
      ? {
          windowKey: last.windowKey,
          status: last.status,
          sent: outcomes.filter((o) => o.status === "SENT").length,
          skipped: outcomes.filter((o) => o.status === "SKIPPED").length,
          failed: outcomes.filter((o) => o.status === "FAILED").length,
        }
      : null,
    nextAt: row.active ? (nextOccurrence(timing, now)?.at.toISOString() ?? null) : null,
  };
}

async function scheduleActor(
  user: AppUser,
  options: { requireSchedule: boolean },
): Promise<{ context: ConsultaContext; userId: string }> {
  const context = await getConsultaContext(user);
  if (!context.access.module) {
    throw new ConsultaError("FORBIDDEN", "Você não tem acesso a Consultas.");
  }
  if (options.requireSchedule && !context.access.schedule) {
    throw new ConsultaError("FORBIDDEN", "Você não tem permissão para agendar envios.");
  }
  const dbUser = await resolveDbUser(user).catch(() => null);
  if (!dbUser) {
    throw new ConsultaError("FORBIDDEN", "Seu usuário não foi encontrado no JumpFlow.");
  }
  return { context, userId: dbUser.id };
}

async function userNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true },
  });
  return new Map(users.map((user) => [user.id, user.name]));
}

/** Agendamentos do próprio usuário (sem override por papel). */
export async function listMySchedules(user: AppUser, now = new Date()): Promise<ScheduleSummary[]> {
  const { userId } = await scheduleActor(user, { requireSchedule: false });
  const rows = (await prisma.consultaSchedule.findMany({
    where: { ownerId: userId },
    select: scheduleSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 200,
  })) as ScheduleRow[];
  const names = await userNames(rows.flatMap((row) => row.recipientUserIds));
  return rows.map((row) => toSummary(row, names, now));
}

export async function getMySchedule(user: AppUser, id: string, now = new Date()): Promise<ScheduleSummary | null> {
  const { userId } = await scheduleActor(user, { requireSchedule: false });
  const row = (await prisma.consultaSchedule.findUnique({
    where: { id },
    select: scheduleSelect,
  })) as ScheduleRow | null;
  if (!row || row.ownerId !== userId) return null;
  return toSummary(row, await userNames(row.recipientUserIds), now);
}

export interface ScheduleFormOptions {
  views: { id: string; name: string }[];
  panels: { id: string; name: string }[];
  /** Só id + nome: e-mail de terceiros não vai ao cliente. */
  users: { id: string; name: string }[];
}

/** Opções do formulário: alvos abertos para quem agenda + usuários ativos. */
export async function getScheduleFormOptions(user: AppUser): Promise<ScheduleFormOptions> {
  await scheduleActor(user, { requireSchedule: true });
  const [views, panels, users] = await Promise.all([
    listSavedViews(user),
    listPanels(user),
    prisma.user.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 2000,
    }),
  ]);
  return {
    views: [...views.mine, ...views.shared]
      .filter((view) => view.available)
      .map((view) => ({ id: view.id, name: view.name })),
    panels: [...panels.mine, ...panels.shared].map((panel) => ({ id: panel.id, name: panel.name })),
    users,
  };
}

function parseInput(raw: unknown) {
  const parsed = scheduleInputSchema.safeParse(raw);
  if (!parsed.success) throw new ConsultaError("INVALID", firstIssue(parsed.error));
  return parsed.data;
}

/** O alvo precisa estar aberto para QUEM AGENDA (com a permissão dele). */
async function checkTarget(user: AppUser, target: { kind: "view" | "panel"; id: string }): Promise<void> {
  if (target.kind === "view") {
    const view = await getSavedViewForViewer(user, target.id);
    if (!view || !view.summary.available) {
      throw new ConsultaError("INVALID", "A visão escolhida não está disponível para você.");
    }
    return;
  }
  const panel = await getPanelForViewer(user, target.id);
  if (!panel) throw new ConsultaError("INVALID", "O painel escolhido não está disponível para você.");
}

/** Destinatários: usuários ATIVOS existentes (nunca e-mail livre). */
async function checkRecipients(ids: string[]): Promise<void> {
  const found = await prisma.user.count({ where: { id: { in: ids }, status: "ACTIVE" } });
  if (found !== ids.length) {
    throw new ConsultaError("INVALID", "Há destinatários inexistentes ou inativos.");
  }
}

function snapshot(data: {
  name: string;
  viewId: string | null;
  panelId: string | null;
  frequency: string;
  hour: number;
  weekday: number | null;
  monthDay: number | null;
  recipientUserIds: string[];
  active: boolean;
}) {
  return {
    name: data.name,
    target: data.viewId ? { kind: "view", id: data.viewId } : { kind: "panel", id: data.panelId },
    frequency: data.frequency,
    hour: data.hour,
    weekday: data.weekday,
    monthDay: data.monthDay,
    recipientUserIds: [...data.recipientUserIds],
    active: data.active,
  };
}

async function audit(
  actorUserId: string | null,
  id: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await recordAuditEvent({ actorUserId, entityType: "ConsultaSchedule", entityId: id, action, before, after });
}

export async function createSchedule(user: AppUser, raw: unknown, now = new Date()): Promise<string> {
  const { userId } = await scheduleActor(user, { requireSchedule: true });
  const input = parseInput(raw);
  await checkTarget(user, input.target);
  await checkRecipients(input.recipientUserIds);
  const timing = normalizeTiming(input);
  const data = {
    ownerId: userId,
    name: input.name,
    viewId: input.target.kind === "view" ? input.target.id : null,
    panelId: input.target.kind === "panel" ? input.target.id : null,
    frequency: timing.frequency,
    hour: timing.hour,
    weekday: timing.weekday,
    monthDay: timing.monthDay,
    recipientUserIds: input.recipientUserIds,
    active: input.active,
    activeSince: now,
  };
  const created = await prisma.consultaSchedule.create({ data, select: { id: true } });
  await audit(userId, created.id, "CONSULTA_AGENDAMENTO_CRIADO", null, snapshot(data));
  return created.id;
}

export async function updateSchedule(user: AppUser, id: string, raw: unknown, now = new Date()): Promise<void> {
  const { userId } = await scheduleActor(user, { requireSchedule: true });
  const row = await prisma.consultaSchedule.findUnique({ where: { id } });
  if (!row || row.ownerId !== userId) throw new ConsultaError("NOT_FOUND", NOT_FOUND_MESSAGE);
  const input = parseInput(raw);
  await checkTarget(user, input.target);
  await checkRecipients(input.recipientUserIds);
  const timing = normalizeTiming(input);
  const timingChanged =
    row.frequency !== timing.frequency ||
    row.hour !== timing.hour ||
    row.weekday !== timing.weekday ||
    row.monthDay !== timing.monthDay;
  const reactivated = !row.active && input.active;
  const data = {
    name: input.name,
    viewId: input.target.kind === "view" ? input.target.id : null,
    panelId: input.target.kind === "panel" ? input.target.id : null,
    frequency: timing.frequency,
    hour: timing.hour,
    weekday: timing.weekday,
    monthDay: timing.monthDay,
    recipientUserIds: input.recipientUserIds,
    active: input.active,
    // Nova regra de horário ou reativação: nada de ocorrência anterior.
    ...(timingChanged || reactivated ? { activeSince: now } : {}),
  };
  await prisma.consultaSchedule.update({ where: { id }, data });
  await audit(userId, id, "CONSULTA_AGENDAMENTO_ATUALIZADO", snapshot(row), snapshot({ ...row, ...data }));
}

/** Excluir: só o dono; não exige AGENDAR (limpeza). */
export async function deleteSchedule(user: AppUser, id: string): Promise<void> {
  const { userId } = await scheduleActor(user, { requireSchedule: false });
  const row = await prisma.consultaSchedule.findUnique({ where: { id } });
  if (!row || row.ownerId !== userId) throw new ConsultaError("NOT_FOUND", NOT_FOUND_MESSAGE);
  await prisma.consultaSchedule.delete({ where: { id } });
  await audit(userId, id, "CONSULTA_AGENDAMENTO_EXCLUIDO", snapshot(row), null);
}

/* ───────────────────────────── Execução ───────────────────────────── */

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

export interface RunClaim {
  runId: string;
  /** Token de posse: só quem o tem grava progresso, renova o lease e fecha o run. */
  token: string;
  /** Resultados de uma tentativa anterior (retentativa): quem já recebeu não recebe de novo. */
  previous: RecipientOutcome[];
}

/**
 * Claim da janela. Cria o run (UNIQUE) ou assume um existente que esteja
 * RUNNING com lease vencido, ou FAILED com tentativas sobrando — num único
 * UPDATE condicional (atômico entre instâncias). null = já feito/em curso.
 */
export async function claimRun(scheduleId: string, windowKey: string, now: Date): Promise<RunClaim | null> {
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const token = randomUUID();
  try {
    const run = await prisma.consultaScheduleRun.create({
      data: { scheduleId, windowKey, status: "RUNNING", leaseUntil, startedAt: now, claimToken: token },
      select: { id: true },
    });
    return { runId: run.id, token, previous: [] };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const taken = await prisma.consultaScheduleRun.updateMany({
    where: {
      scheduleId,
      windowKey,
      attempts: { lt: MAX_RUN_ATTEMPTS },
      OR: [{ status: "RUNNING", leaseUntil: { lt: now } }, { status: "FAILED" }],
    },
    data: { status: "RUNNING", leaseUntil, attempts: { increment: 1 }, claimToken: token },
  });
  if (taken.count !== 1) return null;
  const run = await prisma.consultaScheduleRun.findUnique({
    where: { scheduleId_windowKey: { scheduleId, windowKey } },
    select: { id: true, results: true, claimToken: true },
  });
  if (!run || run.claimToken !== token) return null;
  return { runId: run.id, token, previous: parseOutcomes(run.results) };
}

type ViewTarget = {
  id: string;
  ownerId: string;
  name: string;
  entity: string;
  spec: Prisma.JsonValue;
  sharing: "PRIVATE" | "ROLES" | "ALL";
  sharedRoles: RoleName[];
};

const targetViewSelect = {
  id: true,
  ownerId: true,
  name: true,
  entity: true,
  spec: true,
  sharing: true,
  sharedRoles: true,
} as const;

type JobSchedule = {
  id: string;
  ownerId: string;
  name: string;
  viewId: string | null;
  panelId: string | null;
  frequency: ScheduleFrequency;
  hour: number;
  weekday: number | null;
  monthDay: number | null;
  recipientUserIds: string[];
  activeSince: Date;
};

type Recipient = { appUser: AppUser; viewer: Viewer };

async function loadRecipients(ids: string[]): Promise<Map<string, Recipient>> {
  const users = await prisma.user.findMany({
    where: { id: { in: ids }, status: "ACTIVE" },
    select: { id: true, name: true, email: true, roles: { include: { role: true } } },
  });
  const map = new Map<string, Recipient>();
  for (const user of users) {
    const roles = mapPersistedRoles(user.roles);
    map.set(user.id, {
      appUser: { id: user.id, name: user.name, email: user.email, roles },
      viewer: { userId: user.id, roles },
    });
  }
  return map;
}

/** Do criador só se exige AUTORIDADE para agendar (ativo + CONSULTAS + AGENDAR). Dados nunca. */
async function ownerMaySchedule(ownerId: string): Promise<boolean> {
  const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { status: true } });
  if (!owner || owner.status !== "ACTIVE") return false;
  const matrix = await loadPermissionMatrixForUser(ownerId);
  return (
    matrixAllows(matrix, CONSULTAS_CODES.module, "view") &&
    matrixAllows(matrix, CONSULTAS_CODES.schedule, "view")
  );
}

type Built =
  | { kind: "sheets"; sheets: XlsxSheetSpec[]; sheetCount: number; hiddenViews: number; truncated: boolean }
  | { kind: "skip"; reason: SkipReason };

/** Uma visão para o destinatário, com a permissão DELE. null = sem acesso. */
async function exportViewFor(
  recipient: Recipient,
  context: ConsultaContext,
  view: ViewTarget,
  scheduleId: string,
): Promise<{ data: SheetData; truncated: boolean } | SkipReason> {
  if (!canOpenView(view, recipient.viewer, context.access)) return "sem_acesso_visao";
  if (!specUsableBy(view.spec, context.access)) return "campo_sem_permissao";
  const exported = await exportConsulta(
    recipient.appUser,
    view.spec,
    "xlsx",
    "saved_view",
    { viewId: view.id, scheduleId },
    context,
  );
  return {
    data: { ...exported, entity: exported.validated.entity },
    truncated: exported.truncated,
  };
}

/**
 * Monta a planilha do destinatário com a permissão DELE (matriz + escopo de
 * linha + colunas). Sem acesso → motivo de pulo (sem dados).
 */
async function buildForRecipient(
  recipient: Recipient,
  schedule: JobSchedule,
  target: { view: ViewTarget | null; panel: { row: { ownerId: string; sharing: "PRIVATE" | "ROLES" | "ALL"; sharedRoles: RoleName[]; name: string }; views: (ViewTarget | null)[] } | null },
): Promise<Built> {
  const matrix = await loadPermissionMatrixForUser(recipient.appUser.id);
  const context = await buildConsultaContext(recipient.appUser, matrix);
  if (!context.access.module) return { kind: "skip", reason: "sem_acesso_consultas" };
  if (!context.access.export) return { kind: "skip", reason: "sem_permissao_exportar" };

  const used = new Set<string>();
  if (target.view) {
    const result = await exportViewFor(recipient, context, target.view, schedule.id);
    if (typeof result === "string") return { kind: "skip", reason: result };
    const sheets = [dataSheet(result.data, uniqueSheetName(target.view.name, used))];
    const totals = totalRows(result.data);
    if (totals.length > 0) sheets.push(totalsSheet(totals, uniqueSheetName("Totais", used), false));
    return { kind: "sheets", sheets, sheetCount: 1, hiddenViews: 0, truncated: result.truncated };
  }

  if (!target.panel) return { kind: "skip", reason: "alvo_excluido" };
  if (!canOpenShared(target.panel.row, recipient.viewer)) {
    return { kind: "skip", reason: "sem_acesso_painel" };
  }
  const sheets: XlsxSheetSpec[] = [];
  const totals: ReturnType<typeof totalRows> = [];
  let hiddenViews = 0;
  let truncated = false;
  for (const view of target.panel.views) {
    if (!view) {
      hiddenViews += 1;
      continue;
    }
    const result = await exportViewFor(recipient, context, view, schedule.id);
    if (typeof result === "string") {
      hiddenViews += 1;
      continue;
    }
    sheets.push(dataSheet(result.data, uniqueSheetName(view.name, used)));
    totals.push(...totalRows(result.data, view.name));
    truncated ||= result.truncated;
  }
  if (sheets.length === 0) return { kind: "skip", reason: "nenhuma_visao_acessivel" };
  const sheetCount = sheets.length;
  if (totals.length > 0) sheets.push(totalsSheet(totals, uniqueSheetName("Totais", used), true));
  return { kind: "sheets", sheets, sheetCount, hiddenViews, truncated };
}

async function loadTarget(schedule: JobSchedule) {
  if (schedule.viewId) {
    const view = (await prisma.consultaView.findUnique({
      where: { id: schedule.viewId },
      select: targetViewSelect,
    })) as ViewTarget | null;
    return { view, panel: null, name: view?.name ?? null, kind: "view" as const, id: schedule.viewId };
  }
  const panel = schedule.panelId
    ? await prisma.consultaPanel.findUnique({
        where: { id: schedule.panelId },
        select: { id: true, ownerId: true, name: true, items: true, sharing: true, sharedRoles: true },
      })
    : null;
  if (!panel) return { view: null, panel: null, name: null, kind: "panel" as const, id: schedule.panelId ?? "" };
  const items = parsePanelItems(panel.items);
  const rows = items.length
    ? ((await prisma.consultaView.findMany({
        where: { id: { in: items.map((item) => item.viewId) } },
        select: targetViewSelect,
      })) as ViewTarget[])
    : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  return {
    view: null,
    panel: {
      row: { ownerId: panel.ownerId, sharing: panel.sharing, sharedRoles: panel.sharedRoles as RoleName[], name: panel.name },
      views: items.map((item) => byId.get(item.viewId) ?? null),
    },
    name: panel.name,
    kind: "panel" as const,
    id: panel.id,
  };
}

function appLink(kind: "view" | "panel", id: string): string | null {
  const base = appConfig.url;
  if (!base) return null;
  return `${base}/app/consultas/${kind === "view" ? "visoes" : "paineis"}/${encodeURIComponent(id)}`;
}

/** O run foi reassumido por outra instância (lease vencido): parar sem enviar mais. */
export class LostClaimError extends Error {
  constructor() {
    super("posse do run perdida");
    this.name = "LostClaimError";
  }
}

/**
 * Grava o progresso E renova o lease, só se ainda temos a posse (token).
 * Perdeu a posse → {@link LostClaimError} (o loop aborta sem enviar mais).
 */
async function saveProgress(claim: RunClaim, outcomes: RecipientOutcome[], clock: () => Date): Promise<void> {
  const updated = await prisma.consultaScheduleRun.updateMany({
    where: { id: claim.runId, claimToken: claim.token, status: "RUNNING" },
    data: {
      results: outcomes as unknown as Prisma.InputJsonValue,
      leaseUntil: new Date(clock().getTime() + LEASE_MS),
    },
  });
  if (updated.count !== 1) throw new LostClaimError();
}

/** Processa uma janela já reivindicada: um arquivo por destinatário, com a permissão dele. */
export async function executeRun(
  schedule: JobSchedule,
  claim: RunClaim,
  windowKey: string,
  transport: EmailTransport,
  clock: () => Date = () => new Date(),
  /**
   * Resultados DESTA tentativa, preenchidos por referência: se algo falhar no
   * meio, quem chama ainda sabe quem já recebeu (e não o marca como falha).
   */
  outcomes: RecipientOutcome[] = [],
): Promise<RecipientOutcome[]> {
  const previous = new Map(claim.previous.map((outcome) => [outcome.userId, outcome]));
  const skipAll = (reason: SkipReason) =>
    schedule.recipientUserIds.map((userId): RecipientOutcome => {
      const before = previous.get(userId);
      return before?.status === "SENT" ? before : { userId, status: "SKIPPED", reason };
    });

  if (!(await ownerMaySchedule(schedule.ownerId))) return skipAll("criador_sem_permissao");
  const target = await loadTarget(schedule);
  if (!target.name) return skipAll("alvo_excluido");

  const recipients = await loadRecipients(schedule.recipientUserIds);
  const timing = describeTiming(normalizeTiming(schedule));
  for (const userId of schedule.recipientUserIds) {
    const before = previous.get(userId);
    if (before?.status === "SENT") {
      outcomes.push(before);
      continue;
    }
    const recipient = recipients.get(userId);
    if (!recipient) {
      outcomes.push({ userId, status: "SKIPPED", reason: "usuario_inativo" });
      continue;
    }
    // Antes de gerar/enviar: confirma a posse e renova o lease.
    await saveProgress(claim, outcomes, clock);
    try {
      const built = await buildForRecipient(recipient, schedule, target);
      if (built.kind === "skip") {
        outcomes.push({ userId, status: "SKIPPED", reason: built.reason });
      } else {
        const buffer = await buildWorkbook(built.sheets);
        const email = buildConsultaAgendadaEmail({
          scheduleName: schedule.name,
          targetKind: target.kind,
          targetName: target.name,
          timing,
          sheetCount: built.sheetCount,
          hiddenViews: built.hiddenViews,
          truncated: built.truncated,
          link: appLink(target.kind, target.id),
          recipientName: recipient.appUser.name,
        });
        // Última checagem de posse (e renovação do lease) imediatamente antes de
        // enviar: o arquivo já está pronto, nada caro acontece entre isto e o envio.
        await saveProgress(claim, outcomes, clock);
        await transport.send({
          to: [recipient.appUser.email],
          subject: email.subject,
          text: email.text,
          html: email.html,
          attachments: [
            {
              filename: `${safeFilename(target.name)}_${windowKey.slice(0, 10)}.xlsx`,
              content: buffer.toString("base64"),
              encoding: "base64",
              contentType: XLSX_MIME,
            },
          ],
        });
        outcomes.push({
          userId,
          status: "SENT",
          sheets: built.sheetCount,
          ...(built.hiddenViews > 0 ? { hiddenViews: built.hiddenViews } : {}),
        });
      }
    } catch (error) {
      if (error instanceof LostClaimError) throw error;
      if (isConsultaError(error) && error.code === "FORBIDDEN") {
        outcomes.push({ userId, status: "SKIPPED", reason: "campo_sem_permissao" });
      } else {
        const message = isConsultaError(error)
          ? error.message
          : error instanceof Error
            ? error.message.slice(0, 200)
            : "erro desconhecido";
        console.error("[consultas:agendadas] falha no destinatário", { scheduleId: schedule.id, userId });
        outcomes.push({ userId, status: "FAILED", error: message });
      }
    }
    // Progresso persistido por destinatário: numa retomada, quem já consta como
    // SENT não recebe de novo. (Crash entre o envio e esta gravação → reenvio
    // possível: entrega at-least-once.)
    await saveProgress(claim, outcomes, clock);
  }
  return outcomes;
}

export interface ScheduleJobSummary {
  checked: number;
  due: number;
  processed: number;
  busy: number;
  /** Runs cuja posse foi perdida no meio (outra instância assumiu). */
  lost: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Job: verifica os agendamentos ativos, reivindica as janelas vencidas e
 * envia. Idempotente por janela: chamar de novo não reprocessa uma janela
 * concluída nem reenvia a quem consta como SENT. A entrega em si é
 * at-least-once (ver o cabeçalho do arquivo).
 */
export async function runConsultaSchedules(options: {
  now?: Date;
  transport?: EmailTransport;
  batch?: number;
  /** Relógio para renovar o lease (padrão: `now` + tempo decorrido no job). */
  clock?: () => Date;
} = {}): Promise<ScheduleJobSummary> {
  const now = options.now ?? new Date();
  const startedAt = Date.now();
  const clock = options.clock ?? (() => new Date(now.getTime() + (Date.now() - startedAt)));
  const transport = options.transport ?? getEmailTransport();
  const batch = options.batch ?? JOB_BATCH;
  const summary: ScheduleJobSummary = {
    checked: 0,
    due: 0,
    processed: 0,
    busy: 0,
    lost: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  };

  for await (const schedule of activeSchedules()) {
    await processSchedule(schedule, { now, clock, transport, batch, summary });
  }
  return summary;
}

/** Agendamentos ativos, paginados por id (sem teto fixo). */
async function* activeSchedules(): AsyncGenerator<JobSchedule> {
  let cursor: string | undefined;
  for (;;) {
    const page = (await prisma.consultaSchedule.findMany({
      where: { active: true, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: jobScheduleSelect,
      orderBy: { id: "asc" },
      take: SCHEDULE_PAGE,
    })) as JobSchedule[];
    yield* page;
    if (page.length < SCHEDULE_PAGE) return;
    cursor = page[page.length - 1].id;
  }
}

const jobScheduleSelect = {
  id: true,
  ownerId: true,
  name: true,
  viewId: true,
  panelId: true,
  frequency: true,
  hour: true,
  weekday: true,
  monthDay: true,
  recipientUserIds: true,
  activeSince: true,
} as const;

async function processSchedule(
  schedule: JobSchedule,
  ctx: {
    now: Date;
    clock: () => Date;
    transport: EmailTransport;
    batch: number;
    summary: ScheduleJobSummary;
  },
): Promise<void> {
  const { now, clock, transport, batch, summary } = ctx;
  summary.checked += 1;
  const due = dueOccurrence(normalizeTiming(schedule), schedule.activeSince, now);
  if (!due) return;
  summary.due += 1;
  if (summary.processed >= batch) return;
  const claim = await claimRun(schedule.id, due.windowKey, clock());
  if (!claim) {
    summary.busy += 1;
    return;
  }
  summary.processed += 1;
  let outcomes: RecipientOutcome[];
  const attempt: RecipientOutcome[] = [];
  try {
    outcomes = await executeRun(schedule, claim, due.windowKey, transport, clock, attempt);
  } catch (error) {
    if (error instanceof LostClaimError) {
      // Outra instância assumiu: ela termina; esta não grava nem audita.
      console.warn("[consultas:agendadas] posse do run perdida", { scheduleId: schedule.id, windowKey: due.windowKey });
      summary.lost += 1;
      return;
    }
    console.error("[consultas:agendadas] falha no agendamento", schedule.id, error);
    // Não perde os SENT desta tentativa (nem os de tentativas anteriores):
    // só quem ainda não recebeu/foi pulado vira FAILED (retentável).
    const thisAttempt = new Map(attempt.map((outcome) => [outcome.userId, outcome]));
    const before = new Map(claim.previous.map((outcome) => [outcome.userId, outcome]));
    outcomes = schedule.recipientUserIds.map((userId): RecipientOutcome => {
      const current = thisAttempt.get(userId);
      if (current && current.status !== "FAILED") return current;
      const earlier = before.get(userId);
      if (earlier?.status === "SENT") return earlier;
      return { userId, status: "FAILED", error: "falha ao processar" };
    });
  }
  const status = runStatus(outcomes);
  const closed = await prisma.consultaScheduleRun.updateMany({
    where: { id: claim.runId, claimToken: claim.token, status: "RUNNING" },
    data: {
      status,
      finishedAt: clock(),
      leaseUntil: clock(),
      claimToken: null,
      results: outcomes as unknown as Prisma.InputJsonValue,
    },
  });
  if (closed.count !== 1) {
    console.warn("[consultas:agendadas] posse do run perdida ao fechar", { scheduleId: schedule.id });
    summary.lost += 1;
    return;
  }
  await prisma.consultaSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: now } });
  const counts = {
    sent: outcomes.filter((o) => o.status === "SENT").length,
    skipped: outcomes.filter((o) => o.status === "SKIPPED").length,
    failed: outcomes.filter((o) => o.status === "FAILED").length,
  };
  summary.sent += counts.sent;
  summary.skipped += counts.skipped;
  summary.failed += counts.failed;
  // Registro da execução: quem recebeu, quem foi pulado e por quê (sem dados).
  await audit(null, schedule.id, "CONSULTA_AGENDAMENTO_EXECUTADO", null, {
    windowKey: due.windowKey,
    status,
    ...counts,
    skippedRecipients: outcomes
      .filter((o): o is Extract<RecipientOutcome, { status: "SKIPPED" }> => o.status === "SKIPPED")
      .map((o) => ({ userId: o.userId, reason: o.reason })),
  });
  if (counts.skipped > 0) {
    console.info("[consultas:agendadas] destinatários pulados", {
      scheduleId: schedule.id,
      windowKey: due.windowKey,
      skipped: counts.skipped,
    });
  }
}
