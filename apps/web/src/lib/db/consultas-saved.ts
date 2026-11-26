/**
 * Visões salvas e painéis de Consultas (ESPECIFICAÇÃO §6 C2) — servidor.
 *
 * Regras (todas aplicadas AQUI, a cada leitura/escrita):
 * - abrir: dono, `ALL` ou `ROLES` com papel em comum + `CONSULTAS` + entidade
 *   liberada + spec válida para quem vê. Fora disso a resposta é NOT_FOUND,
 *   sem distinguir "não existe" de "sem acesso" (não vaza nome nem existência);
 * - executar/exportar: a spec é lida do banco e roda com a permissão e o
 *   escopo de linha de QUEM VÊ (`origin: "saved_view"`), nunca do dono;
 * - criar exige `CONSULTAS_CRIAR`; compartilhar (ROLES/ALL) exige
 *   `CONSULTAS_COMPARTILHAR`; alterar/excluir só o dono (sem override por
 *   papel global);
 * - painel: ≤ 24 visões; ao renderizar, cada visão é revalidada para quem vê
 *   e as inacessíveis somem (só a CONTAGEM é informada);
 * - auditoria: criar, alterar, compartilhar e excluir.
 *
 * Assume banco configurado: os chamadores checam `isDatabaseConfigured()`.
 */
import { Prisma, prisma } from "@jumpflow/database";
import type { AppUser } from "@/lib/auth/types";
import { recordAuditEvent } from "@/lib/db/audit";
import { resolveDbUser } from "@/lib/db/users";
import {
  exportConsulta,
  getConsultaContext,
  runConsulta,
  type ConsultaContext,
  type ConsultaExportData,
  type ConsultaRunResult,
} from "@/lib/db/consultas";
import { getEntity } from "@/lib/consultas/catalog";
import { ConsultaError } from "@/lib/consultas/errors";
import {
  canOpenShared,
  canOpenView,
  firstIssue,
  isOwner,
  MAX_PANEL_ITEMS,
  panelInputSchema,
  parsePanelItems,
  sharingAllowed,
  specUsableBy,
  viewInputSchema,
  type PanelItem,
  type PanelItemSize,
  type Sharing,
  type Viewer,
  type Visualization,
} from "@/lib/consultas/saved";
import { validateConsulta } from "@/lib/consultas/validate";
import type { RoleName } from "@/lib/auth/roles";

const NOT_FOUND_MESSAGE = "Visão não encontrada ou sem acesso.";
const PANEL_NOT_FOUND_MESSAGE = "Painel não encontrado ou sem acesso.";
/** Teto defensivo de itens listados (visões/painéis) por tela. */
const LIST_LIMIT = 500;

export interface SavedViewSummary {
  id: string;
  name: string;
  description: string | null;
  entity: string;
  entityLabel: string;
  visualization: Visualization;
  sharing: Sharing;
  sharedRoles: RoleName[];
  ownerName: string;
  isOwner: boolean;
  /** Spec roda para quem vê (só o dono vê uma visão indisponível, para poder excluí-la). */
  available: boolean;
  updatedAt: string;
}

export interface SavedPanelSummary {
  id: string;
  name: string;
  description: string | null;
  sharing: Sharing;
  sharedRoles: RoleName[];
  ownerName: string;
  isOwner: boolean;
  updatedAt: string;
}

export interface PanelViewItem {
  viewId: string;
  size: PanelItemSize;
  view: SavedViewSummary;
}

export interface PanelForViewer {
  panel: SavedPanelSummary;
  items: PanelViewItem[];
  /** Itens que quem vê NÃO pode abrir (nunca com nome). */
  hiddenCount: number;
  /**
   * Só para o dono: itens que ELE pode abrir hoje (para editar). Os demais
   * nunca vão ao cliente, nem o id — só a contagem `hiddenCount`; ao salvar,
   * o dono escolhe mantê-los ou removê-los em bloco (`keepUnavailable`).
   */
  ownerItems?: { viewId: string; size: PanelItemSize }[];
}

type ViewRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  entity: string;
  spec: Prisma.JsonValue;
  visualization: Visualization;
  sharing: Sharing;
  sharedRoles: RoleName[];
  updatedAt: Date;
  owner: { name: string };
};

type PanelRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  items: Prisma.JsonValue;
  sharing: Sharing;
  sharedRoles: RoleName[];
  updatedAt: Date;
  owner: { name: string };
};

const viewSelect = {
  id: true,
  ownerId: true,
  name: true,
  description: true,
  entity: true,
  spec: true,
  visualization: true,
  sharing: true,
  sharedRoles: true,
  updatedAt: true,
  owner: { select: { name: true } },
} as const;

const panelSelect = {
  id: true,
  ownerId: true,
  name: true,
  description: true,
  items: true,
  sharing: true,
  sharedRoles: true,
  updatedAt: true,
  owner: { select: { name: true } },
} as const;

async function resolveViewer(user: AppUser): Promise<Viewer> {
  const dbUser = await resolveDbUser(user).catch(() => null);
  return { userId: dbUser?.id ?? null, roles: user.roles };
}

/** Filtro de banco que já corta o que certamente não é visível (o resto é checado em TS). */
function visibleWhere(viewer: Viewer) {
  return {
    OR: [
      ...(viewer.userId ? [{ ownerId: viewer.userId }] : []),
      { sharing: "ALL" as const },
      { sharing: "ROLES" as const, sharedRoles: { hasSome: [...viewer.roles] } },
    ],
  };
}

function toViewSummary(
  row: ViewRow,
  viewer: Viewer,
  context: ConsultaContext,
): SavedViewSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    entity: row.entity,
    entityLabel: getEntity(row.entity)?.label ?? row.entity,
    visualization: row.visualization,
    sharing: row.sharing,
    sharedRoles: row.sharedRoles,
    ownerName: row.owner.name,
    isOwner: isOwner(row, viewer),
    available: specUsableBy(row.spec, context.access),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toPanelSummary(row: PanelRow, viewer: Viewer): SavedPanelSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sharing: row.sharing,
    sharedRoles: row.sharedRoles,
    ownerName: row.owner.name,
    isOwner: isOwner(row, viewer),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Visível para quem vê? Dono vê a própria visão mesmo com spec indisponível
 * (para excluir/ajustar), desde que ainda veja a entidade; demais só se a spec
 * roda com a permissão dele.
 */
function viewVisible(row: ViewRow, viewer: Viewer, context: ConsultaContext): SavedViewSummary | null {
  if (!canOpenView(row, viewer, context.access)) return null;
  const summary = toViewSummary(row, viewer, context);
  if (!summary.available && !summary.isOwner) return null;
  return summary;
}

async function audit(
  viewer: Viewer,
  entityType: "ConsultaView" | "ConsultaPanel",
  entityId: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: viewer.userId,
    entityType,
    entityId,
    action,
    before,
    after,
  });
}

function sharingSnapshot(row: { sharing: Sharing; sharedRoles: readonly string[] }) {
  return { sharing: row.sharing, sharedRoles: [...row.sharedRoles] };
}

function sharingChanged(
  before: { sharing: Sharing; sharedRoles: readonly string[] },
  after: { sharing: Sharing; sharedRoles: readonly string[] },
): boolean {
  if (before.sharing !== after.sharing) return true;
  const a = [...before.sharedRoles].sort().join(",");
  const b = [...after.sharedRoles].sort().join(",");
  return a !== b;
}

function requireModule(context: ConsultaContext): void {
  if (!context.access.module) {
    throw new ConsultaError("FORBIDDEN", "Você não tem acesso a Consultas.");
  }
}

function requireDbUser(viewer: Viewer): string {
  if (!viewer.userId) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Seu usuário não foi encontrado no JumpFlow; não é possível salvar.",
    );
  }
  return viewer.userId;
}

function requireSharing(sharing: Sharing, context: ConsultaContext): void {
  if (!sharingAllowed(sharing, context.access)) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Você não tem permissão para compartilhar visões e painéis.",
    );
  }
}

/* ───────────────────────────── Visões ───────────────────────────── */

export async function listSavedViews(
  user: AppUser,
): Promise<{ mine: SavedViewSummary[]; shared: SavedViewSummary[] }> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  if (!context.access.module) return { mine: [], shared: [] };
  const rows = (await prisma.consultaView.findMany({
    where: visibleWhere(viewer),
    select: viewSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: LIST_LIMIT,
  })) as ViewRow[];
  const mine: SavedViewSummary[] = [];
  const shared: SavedViewSummary[] = [];
  for (const row of rows) {
    const summary = viewVisible(row, viewer, context);
    if (!summary) continue;
    (summary.isOwner ? mine : shared).push(summary);
  }
  return { mine, shared };
}

async function loadViewFor(
  user: AppUser,
  id: string,
): Promise<{ row: ViewRow; summary: SavedViewSummary; viewer: Viewer; context: ConsultaContext }> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  const row = (await prisma.consultaView.findUnique({
    where: { id },
    select: viewSelect,
  })) as ViewRow | null;
  const summary = row ? viewVisible(row, viewer, context) : null;
  if (!row || !summary) throw new ConsultaError("NOT_FOUND", NOT_FOUND_MESSAGE);
  return { row, summary, viewer, context };
}

/** Visão para a página de detalhe (null = inexistente ou sem acesso). */
export async function getSavedViewForViewer(
  user: AppUser,
  id: string,
): Promise<{ summary: SavedViewSummary; spec: unknown } | null> {
  try {
    const { row, summary } = await loadViewFor(user, id);
    return { summary, spec: row.spec };
  } catch (error) {
    if (error instanceof ConsultaError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** Executa a visão com a permissão e o escopo de QUEM VÊ. */
export async function runSavedView(
  user: AppUser,
  id: string,
  page = 1,
): Promise<ConsultaRunResult> {
  const { row, summary, context } = await loadViewFor(user, id);
  if (!summary.available) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Esta visão usa dados que seu perfil não pode consultar.",
    );
  }
  return runConsulta(user, row.spec, page, "saved_view", { viewId: row.id }, context);
}

/** Exporta a visão (spec lida aqui; nunca do cliente). */
export async function exportSavedView(
  user: AppUser,
  id: string,
  format: "xlsx" | "csv",
): Promise<ConsultaExportData & { viewName: string }> {
  const { row, summary, context } = await loadViewFor(user, id);
  if (!summary.available) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Esta visão usa dados que seu perfil não pode consultar.",
    );
  }
  const data = await exportConsulta(user, row.spec, format, "saved_view", { viewId: row.id }, context);
  return { ...data, viewName: row.name };
}

export interface SaveViewInput {
  spec: unknown;
  name: unknown;
  description?: unknown;
  visualization: unknown;
  sharing: unknown;
  sharedRoles?: unknown;
}

/** Cria a visão a partir do construtor (exige CRIAR; spec validada com a permissão do dono). */
export async function createSavedView(user: AppUser, input: SaveViewInput): Promise<string> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  if (!context.access.create) {
    throw new ConsultaError("FORBIDDEN", "Você não tem permissão para criar consultas.");
  }
  const parsed = viewInputSchema.safeParse({
    name: input.name,
    description: input.description,
    visualization: input.visualization,
    sharing: input.sharing,
    sharedRoles: input.sharedRoles ?? [],
  });
  if (!parsed.success) throw new ConsultaError("INVALID", firstIssue(parsed.error));
  requireSharing(parsed.data.sharing, context);
  const validated = validateConsulta(input.spec, context.access);
  const ownerId = requireDbUser(viewer);

  const created = await prisma.consultaView.create({
    data: {
      ownerId,
      name: parsed.data.name,
      description: parsed.data.description,
      entity: validated.entity.key,
      spec: validated.spec as unknown as Prisma.InputJsonValue,
      visualization: parsed.data.visualization,
      sharing: parsed.data.sharing,
      sharedRoles: parsed.data.sharedRoles,
    },
    select: { id: true },
  });
  const snapshot = {
    name: parsed.data.name,
    entity: validated.entity.key,
    visualization: parsed.data.visualization,
    ...sharingSnapshot(parsed.data),
    spec: validated.spec,
  };
  await audit(viewer, "ConsultaView", created.id, "CONSULTA_VISAO_CRIADA", null, snapshot);
  if (parsed.data.sharing !== "PRIVATE") {
    await audit(
      viewer,
      "ConsultaView",
      created.id,
      "CONSULTA_VISAO_COMPARTILHADA",
      { sharing: "PRIVATE", sharedRoles: [] },
      sharingSnapshot(parsed.data),
    );
  }
  return created.id;
}

export interface UpdateViewInput extends Omit<SaveViewInput, "spec"> {
  /** Nova spec (opcional): exige CRIAR e é validada com a permissão do dono. */
  spec?: unknown;
}

/** Altera a visão (só o dono). */
export async function updateSavedView(
  user: AppUser,
  id: string,
  input: UpdateViewInput,
): Promise<void> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  const row = (await prisma.consultaView.findUnique({
    where: { id },
    select: viewSelect,
  })) as ViewRow | null;
  // Não-dono recebe o mesmo NOT_FOUND de "não existe": não vaza existência.
  // O dono só altera/recompartilha o que ainda pode abrir (entidade liberada
  // e spec válida para ele); sem isso, o mesmo 404. Excluir continua liberado.
  const current = row ? viewVisible(row, viewer, context) : null;
  if (!row || !current || !current.isOwner || !current.available) {
    throw new ConsultaError("NOT_FOUND", NOT_FOUND_MESSAGE);
  }

  const parsed = viewInputSchema.safeParse({
    name: input.name,
    description: input.description,
    visualization: input.visualization,
    sharing: input.sharing,
    sharedRoles: input.sharedRoles ?? [],
  });
  if (!parsed.success) throw new ConsultaError("INVALID", firstIssue(parsed.error));
  const changedSharing = sharingChanged(row, parsed.data);
  if (changedSharing) requireSharing(parsed.data.sharing, context);

  let spec: Prisma.InputJsonValue | undefined;
  let entity: string | undefined;
  if (input.spec !== undefined) {
    if (!context.access.create) {
      throw new ConsultaError("FORBIDDEN", "Você não tem permissão para criar consultas.");
    }
    const validated = validateConsulta(input.spec, context.access);
    spec = validated.spec as unknown as Prisma.InputJsonValue;
    entity = validated.entity.key;
  }

  await prisma.consultaView.update({
    where: { id },
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      visualization: parsed.data.visualization,
      sharing: parsed.data.sharing,
      sharedRoles: parsed.data.sharedRoles,
      ...(spec !== undefined ? { spec, entity } : {}),
    },
  });
  await audit(
    viewer,
    "ConsultaView",
    id,
    "CONSULTA_VISAO_ATUALIZADA",
    { name: row.name, entity: row.entity, visualization: row.visualization, spec: row.spec },
    {
      name: parsed.data.name,
      entity: entity ?? row.entity,
      visualization: parsed.data.visualization,
      ...(spec !== undefined ? { spec } : {}),
    },
  );
  if (changedSharing) {
    await audit(
      viewer,
      "ConsultaView",
      id,
      "CONSULTA_VISAO_COMPARTILHADA",
      sharingSnapshot(row),
      sharingSnapshot(parsed.data),
    );
  }
}

/** Exclui a visão (só o dono). Painéis que a citam passam a ignorá-la. */
export async function deleteSavedView(user: AppUser, id: string): Promise<void> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  const row = await prisma.consultaView.findUnique({
    where: { id },
    select: { id: true, ownerId: true, name: true, entity: true, sharing: true, sharedRoles: true },
  });
  if (!row || !isOwner(row, viewer)) throw new ConsultaError("NOT_FOUND", NOT_FOUND_MESSAGE);
  await prisma.consultaView.delete({ where: { id } });
  await audit(
    viewer,
    "ConsultaView",
    id,
    "CONSULTA_VISAO_EXCLUIDA",
    { name: row.name, entity: row.entity, ...sharingSnapshot(row) },
    null,
  );
}

/* ───────────────────────────── Painéis ───────────────────────────── */

export async function listPanels(
  user: AppUser,
): Promise<{ mine: SavedPanelSummary[]; shared: SavedPanelSummary[] }> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  if (!context.access.module) return { mine: [], shared: [] };
  const rows = (await prisma.consultaPanel.findMany({
    where: visibleWhere(viewer),
    select: panelSelect,
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: LIST_LIMIT,
  })) as PanelRow[];
  const mine: SavedPanelSummary[] = [];
  const shared: SavedPanelSummary[] = [];
  for (const row of rows) {
    if (!canOpenShared(row, viewer)) continue;
    const summary = toPanelSummary(row, viewer);
    (summary.isOwner ? mine : shared).push(summary);
  }
  return { mine, shared };
}

/**
 * Painel para quem vê: cada visão é revalidada para ESTA pessoa. Visão
 * privada de outro dono, de entidade sem acesso, com campos que ela não pode
 * ver ou excluída não aparece — só entra na contagem `hiddenCount`.
 */
export async function getPanelForViewer(
  user: AppUser,
  id: string,
): Promise<PanelForViewer | null> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  if (!context.access.module) return null;
  const row = (await prisma.consultaPanel.findUnique({
    where: { id },
    select: panelSelect,
  })) as PanelRow | null;
  if (!row || !canOpenShared(row, viewer)) return null;

  const stored = parsePanelItems(row.items);
  const views = stored.length
    ? ((await prisma.consultaView.findMany({
        where: { id: { in: stored.map((item) => item.viewId) } },
        select: viewSelect,
      })) as ViewRow[])
    : [];
  const byId = new Map(views.map((view) => [view.id, view]));
  const items: PanelViewItem[] = [];
  let hiddenCount = 0;
  for (const item of stored) {
    const view = byId.get(item.viewId);
    const summary = view ? viewVisible(view, viewer, context) : null;
    if (!summary || !summary.available) {
      hiddenCount += 1;
      continue;
    }
    items.push({ viewId: item.viewId, size: item.size, view: summary });
  }
  const panel = toPanelSummary(row, viewer);
  return {
    panel,
    items,
    hiddenCount,
    ...(panel.isOwner
      ? { ownerItems: items.map((item) => ({ viewId: item.viewId, size: item.size })) }
      : {}),
  };
}

export interface SavePanelInput {
  /**
   * Edição: manter (true, padrão) ou remover em bloco os itens que o dono não
   * pode mais abrir. O cliente nunca conhece esses itens, só a contagem.
   */
  keepUnavailable?: unknown;
  name: unknown;
  description?: unknown;
  items: unknown;
  sharing: unknown;
  sharedRoles?: unknown;
}

/** Toda visão citada precisa estar aberta para quem monta o painel. */
async function checkPanelItems(
  items: { viewId: string }[],
  viewer: Viewer,
  context: ConsultaContext,
): Promise<void> {
  const views = (await prisma.consultaView.findMany({
    where: { id: { in: items.map((item) => item.viewId) } },
    select: viewSelect,
  })) as ViewRow[];
  const byId = new Map(views.map((view) => [view.id, view]));
  for (const item of items) {
    // Todo item enviado pelo cliente precisa estar aberto para o dono; os
    // indisponíveis já gravados são tratados à parte (`keepUnavailable`).
    const view = byId.get(item.viewId);
    const summary = view ? viewVisible(view, viewer, context) : null;
    if (!summary || !summary.available) {
      throw new ConsultaError(
        "INVALID",
        "Uma das visões escolhidas não está disponível para você.",
      );
    }
  }
}

function parsePanel(input: SavePanelInput) {
  const parsed = panelInputSchema.safeParse({
    name: input.name,
    description: input.description,
    items: input.items,
    sharing: input.sharing,
    sharedRoles: input.sharedRoles ?? [],
  });
  if (!parsed.success) throw new ConsultaError("INVALID", firstIssue(parsed.error));
  return parsed.data;
}

export async function createPanel(user: AppUser, input: SavePanelInput): Promise<string> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  if (!context.access.create) {
    throw new ConsultaError("FORBIDDEN", "Você não tem permissão para criar painéis.");
  }
  const data = parsePanel(input);
  requireSharing(data.sharing, context);
  const ownerId = requireDbUser(viewer);
  await checkPanelItems(data.items, viewer, context);
  const created = await prisma.consultaPanel.create({
    data: {
      ownerId,
      name: data.name,
      description: data.description,
      items: data.items as unknown as Prisma.InputJsonValue,
      sharing: data.sharing,
      sharedRoles: data.sharedRoles,
    },
    select: { id: true },
  });
  await audit(viewer, "ConsultaPanel", created.id, "CONSULTA_PAINEL_CRIADO", null, {
    name: data.name,
    items: data.items,
    ...sharingSnapshot(data),
  });
  if (data.sharing !== "PRIVATE") {
    await audit(
      viewer,
      "ConsultaPanel",
      created.id,
      "CONSULTA_PAINEL_COMPARTILHADO",
      { sharing: "PRIVATE", sharedRoles: [] },
      sharingSnapshot(data),
    );
  }
  return created.id;
}

/** Itens gravados que quem vê não pode abrir hoje (inexistente, sem acesso ou spec inválida). */
async function unavailableItems(
  items: PanelItem[],
  viewer: Viewer,
  context: ConsultaContext,
): Promise<PanelItem[]> {
  if (items.length === 0) return [];
  const views = (await prisma.consultaView.findMany({
    where: { id: { in: items.map((item) => item.viewId) } },
    select: viewSelect,
  })) as ViewRow[];
  const byId = new Map(views.map((view) => [view.id, view]));
  return items.filter((item) => {
    const view = byId.get(item.viewId);
    const summary = view ? viewVisible(view, viewer, context) : null;
    return !summary || !summary.available;
  });
}

export async function updatePanel(user: AppUser, id: string, input: SavePanelInput): Promise<void> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  const row = (await prisma.consultaPanel.findUnique({
    where: { id },
    select: panelSelect,
  })) as PanelRow | null;
  if (!row || !isOwner(row, viewer)) throw new ConsultaError("NOT_FOUND", PANEL_NOT_FOUND_MESSAGE);
  // Editar painel exige CRIAR, como criar.
  if (!context.access.create) {
    throw new ConsultaError("FORBIDDEN", "Você não tem permissão para editar painéis.");
  }
  const data = parsePanel(input);
  const changedSharing = sharingChanged(row, data);
  if (changedSharing) requireSharing(data.sharing, context);
  await checkPanelItems(data.items, viewer, context);

  // Itens já gravados que o dono NÃO pode abrir hoje: o cliente nunca os viu
  // (nem o id). Mantidos no fim do painel (padrão) ou removidos em bloco.
  const previous = parsePanelItems(row.items);
  const unavailable = await unavailableItems(previous, viewer, context);
  const sent = new Set(data.items.map((item) => item.viewId));
  const keep = input.keepUnavailable !== false;
  const kept = keep ? unavailable.filter((item) => !sent.has(item.viewId)) : [];
  const items = [...data.items, ...kept];
  if (items.length > MAX_PANEL_ITEMS) {
    throw new ConsultaError(
      "INVALID",
      `Um painel tem no máximo ${MAX_PANEL_ITEMS} visões (contando as indisponíveis mantidas).`,
    );
  }

  await prisma.consultaPanel.update({
    where: { id },
    data: {
      name: data.name,
      description: data.description,
      items: items as unknown as Prisma.InputJsonValue,
      sharing: data.sharing,
      sharedRoles: data.sharedRoles,
    },
  });
  await audit(
    viewer,
    "ConsultaPanel",
    id,
    "CONSULTA_PAINEL_ATUALIZADO",
    { name: row.name, items: previous },
    {
      name: data.name,
      items,
      unavailableKept: kept.length,
      unavailableRemoved: unavailable.length - kept.length,
    },
  );
  if (changedSharing) {
    await audit(
      viewer,
      "ConsultaPanel",
      id,
      "CONSULTA_PAINEL_COMPARTILHADO",
      sharingSnapshot(row),
      sharingSnapshot(data),
    );
  }
}

export async function deletePanel(user: AppUser, id: string): Promise<void> {
  const [context, viewer] = await Promise.all([getConsultaContext(user), resolveViewer(user)]);
  requireModule(context);
  const row = await prisma.consultaPanel.findUnique({
    where: { id },
    select: { id: true, ownerId: true, name: true, sharing: true, sharedRoles: true },
  });
  if (!row || !isOwner(row, viewer)) throw new ConsultaError("NOT_FOUND", PANEL_NOT_FOUND_MESSAGE);
  await prisma.consultaPanel.delete({ where: { id } });
  await audit(
    viewer,
    "ConsultaPanel",
    id,
    "CONSULTA_PAINEL_EXCLUIDO",
    { name: row.name, ...sharingSnapshot(row) },
    null,
  );
}
