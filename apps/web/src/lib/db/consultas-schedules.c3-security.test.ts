import { readFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";
import type { EmailMessage, EmailTransport } from "@/lib/automation/email-transport";

/**
 * Fase C3 (testador): envio agendado — segurança e idempotência do job.
 * - cada destinatário com a PRÓPRIA matriz/escopo/papéis (nunca do criador,
 *   nunca da sessão);
 * - pulos registrados (sem acesso ao módulo, sem exportar, sem painel...);
 * - criador sem autoridade (sem AGENDAR, sem módulo, inativo, removido);
 * - jobs concorrentes, retomada após crash, progresso por destinatário;
 * - painel: abas só das visões acessíveis, sem nome das inacessíveis
 *   (planilha, e-mail e auditoria).
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  users: [] as { id: string; name: string; email: string; status: string; roles: string[] }[],
  matrices: {} as Record<string, PermissionMatrix>,
  views: {} as Record<string, Row>,
  panels: {} as Record<string, Row>,
  schedules: [] as Row[],
  runs: [] as Row[],
  runUpdates: [] as { id: string; results: unknown }[],
  sqlValues: [] as unknown[][],
  recordAuditEvent: vi.fn(async (input: unknown) => void input),
  getCurrentMatrix: vi.fn(),
  resolveDbUser: vi.fn(),
  loadMatrix: vi.fn(),
  resolveReportScope: vi.fn(),
}));

function uniqueError() {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

vi.mock("@jumpflow/database", async () => {
  const actual = await vi.importActual<typeof import("@jumpflow/database")>("@jumpflow/database");
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (sql: { strings: readonly string[]; values: unknown[] }) => {
      h.sqlValues.push(sql.values);
      if (sql.strings.join("?").includes('AS "total"')) return [{ total: 1 }];
      return [{ c0: "2026-11-20", c1: "Ana", c2: 8, m0: 8 }];
    }),
  };
  const matchRun = (where: Row) =>
    h.runs.find((run) => run.scheduleId === where.scheduleId && run.windowKey === where.windowKey);
  return {
    Prisma: actual.Prisma,
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      user: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; status?: string } }) =>
          h.users
            .filter((u) => where.id.in.includes(u.id) && (!where.status || u.status === where.status))
            .map((u) => ({ ...u, roles: u.roles.map((name) => ({ role: { name } })) })),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.users.find((u) => u.id === where.id) ?? null),
        count: vi.fn(async () => 0),
      },
      consultaView: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.views[where.id] ?? null),
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
          where.id.in.map((id) => h.views[id]).filter(Boolean),
        ),
      },
      consultaPanel: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.panels[where.id] ?? null),
      },
      consultaSchedule: {
        findMany: vi.fn(async ({ take }: { take: number }) => h.schedules.filter((s) => s.active).slice(0, take)),
        findUnique: vi.fn(async () => null),
        update: vi.fn(async () => ({})),
      },
      consultaScheduleRun: {
        create: vi.fn(async ({ data }: { data: Row }) => {
          if (matchRun(data)) throw uniqueError();
          const run = { id: `run-${h.runs.length + 1}`, attempts: 1, results: null, ...data };
          h.runs.push(run);
          return { id: run.id };
        }),
        updateMany: vi.fn(async ({ where, data }: { where: Row & { OR: Row[]; attempts: { lt: number } }; data: Row }) => {
          if (where.id) {
            // Progresso/fechamento: só com o token de posse e o run ainda RUNNING.
            const owned = h.runs.find((r) => r.id === where.id && r.claimToken === where.claimToken && r.status === where.status);
            if (!owned) return { count: 0 };
            h.runUpdates.push({ id: where.id as string, results: JSON.parse(JSON.stringify(data.results ?? null)) });
            Object.assign(owned, data);
            return { count: 1 };
          }
          const run = matchRun(where);
          if (!run || (run.attempts as number) >= where.attempts.lt) return { count: 0 };
          const now = (where.OR[0].leaseUntil as { lt: Date }).lt;
          const stale = run.status === "RUNNING" && (run.leaseUntil as Date) < now;
          if (!stale && run.status !== "FAILED") return { count: 0 };
          Object.assign(run, { status: data.status, leaseUntil: data.leaseUntil, claimToken: data.claimToken, attempts: (run.attempts as number) + 1 });
          return { count: 1 };
        }),
        findUnique: vi.fn(async ({ where }: { where: { scheduleId_windowKey: Row } }) => matchRun(where.scheduleId_windowKey) ?? null),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
          const run = h.runs.find((r) => r.id === where.id)!;
          h.runUpdates.push({ id: where.id, results: JSON.parse(JSON.stringify(data.results ?? null)) });
          Object.assign(run, data);
          return run;
        }),
      },
    },
  };
});
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: h.recordAuditEvent }));
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix: h.getCurrentMatrix, can: vi.fn(async () => { throw new Error("sem sessão no job"); }) }));
vi.mock("@/lib/auth/sensitive-data", () => ({ canAccessSensitiveCost: () => false }));
vi.mock("@/lib/db/permissions", () => ({ loadPermissionMatrixForUser: h.loadMatrix }));
vi.mock("@/lib/db/users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/users")>("@/lib/db/users");
  return { mapPersistedRoles: actual.mapPersistedRoles, resolveDbUser: h.resolveDbUser };
});
vi.mock("@/lib/db/reports", () => ({ resolveReportScope: h.resolveReportScope }));
vi.mock("@/lib/db/consultas-saved", () => ({
  getSavedViewForViewer: vi.fn(),
  getPanelForViewer: vi.fn(),
  listSavedViews: vi.fn(async () => ({ mine: [], shared: [] })),
  listPanels: vi.fn(async () => ({ mine: [], shared: [] })),
}));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { buildConsultaAgendadaEmail } from "@/lib/automation/email/templates";
import { runConsultaSchedules } from "./consultas-schedules";

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const READ = ["CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"];
const hoursSpec = { entity: "horas", filters: null, columns: ["data", "consultor", "horas"], groupBy: [], measures: [], sort: [] };
const NOW = new Date("2026-11-26T12:00:00Z");

function transport() {
  const sent: EmailMessage[] = [];
  const t: EmailTransport = {
    send: vi.fn(async (message: EmailMessage) => {
      sent.push(message);
      return { id: `m${sent.length}`, provider: "test" };
    }),
  };
  return { t, sent };
}

function schedule(overrides: Row = {}): Row {
  return {
    id: "s1",
    ownerId: "u-owner",
    name: "Horas da semana",
    viewId: "v1",
    panelId: null,
    frequency: "DAILY",
    hour: 8,
    weekday: null,
    monthDay: null,
    recipientUserIds: ["u-fin", "u-pm"],
    active: true,
    activeSince: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

function audits(action: string) {
  return h.recordAuditEvent.mock.calls
    .map((call) => call[0] as { action: string; actorUserId: string | null; after: Row })
    .filter((event) => event.action === action);
}

async function workbookOf(message: EmailMessage) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(message.attachments![0].content, "base64") as unknown as ArrayBuffer);
  const names = wb.worksheets.map((ws) => ws.name);
  const cells: string[] = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value)))));
  return { names, cells: cells.join("|") };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.users = [
    { id: "u-owner", name: "Ana Admin", email: "ana@jump", status: "ACTIVE", roles: ["ADMIN"] },
    { id: "u-fin", name: "Fábio Fin", email: "fin@jump", status: "ACTIVE", roles: ["FINANCE"] },
    { id: "u-pm", name: "Paula PM", email: "pm@jump", status: "ACTIVE", roles: ["PROJECT_MANAGER"] },
    { id: "u-people", name: "Pedro People", email: "people@jump", status: "ACTIVE", roles: ["PEOPLE"] },
    { id: "u-nomod", name: "Sem Módulo", email: "nomod@jump", status: "ACTIVE", roles: ["FINANCE"] },
  ];
  h.matrices = {
    "u-owner": grant(...READ, "CONSULTAS_AGENDAR", "CONSULTAS_CRIAR"),
    "u-fin": grant(...READ),
    "u-pm": grant(...READ),
    "u-people": grant("CONSULTAS", "CONSULTAS_CONSULTORES", "CONSULTAS_EXPORTAR"),
    // Tem a entidade e EXPORTAR, mas não o módulo CONSULTAS.
    "u-nomod": grant("CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"),
  };
  h.views = {
    v1: { id: "v1", ownerId: "u-owner", name: "Horas por consultor", entity: "horas", spec: hoursSpec, sharing: "ALL", sharedRoles: [] },
  };
  h.panels = {};
  h.schedules = [schedule()];
  h.runs = [];
  h.runUpdates = [];
  h.sqlValues = [];
  h.getCurrentMatrix.mockRejectedValue(new Error("sem sessão no job"));
  h.resolveDbUser.mockImplementation(async (user: AppUser) => ({ id: user.id, name: user.name, email: user.email }));
  h.loadMatrix.mockImplementation(async (id: string) => h.matrices[id] ?? {});
  h.resolveReportScope.mockImplementation(async (user: AppUser, matrix?: PermissionMatrix) => {
    if (!matrix) throw new Error("o job precisa passar a matriz do destinatário");
    const broad = user.roles.some((role) => role === "ADMIN" || role === "FINANCE");
    return broad
      ? { broad: true, includeFinancials: true, financeHoursLimited: false }
      : { broad: false, managerUserId: user.id, includeFinancials: false, financeHoursLimited: false };
  });
});

describe("job (testador): cada destinatário com a PRÓPRIA matriz, escopo e papéis", () => {
  it("a matriz e o escopo de cada destinatário são os DELE (ids e papéis do banco), nunca os do criador", async () => {
    const { t } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    const scopeCalls = h.resolveReportScope.mock.calls as [AppUser, PermissionMatrix][];
    expect(scopeCalls.map(([user]) => [user.id, user.roles])).toEqual([
      ["u-fin", ["FINANCE"]],
      ["u-pm", ["PROJECT_MANAGER"]],
    ]);
    expect(scopeCalls[0][1]).toBe(h.matrices["u-fin"]);
    expect(scopeCalls[1][1]).toBe(h.matrices["u-pm"]);
    // Do criador, a matriz só é lida para a AUTORIDADE de agendar (1 vez), nunca para dados.
    expect(h.loadMatrix.mock.calls.map((call) => call[0])).toEqual(["u-owner", "u-fin", "u-pm"]);
    expect(scopeCalls.some(([user]) => user.id === "u-owner")).toBe(false);
    expect(h.getCurrentMatrix).not.toHaveBeenCalled();
  });

  it("destinatário com a entidade e EXPORTAR, mas sem o módulo CONSULTAS → pulado (sem_acesso_consultas), sem consulta", async () => {
    h.schedules = [schedule({ recipientUserIds: ["u-nomod"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.sqlValues).toHaveLength(0);
    expect(h.runs[0].results).toEqual([{ userId: "u-nomod", status: "SKIPPED", reason: "sem_acesso_consultas" }]);
  });

  it("falha ao ler a matriz do destinatário → FAILED para ele (nada enviado), os demais seguem", async () => {
    h.loadMatrix.mockImplementation(async (id: string) => {
      if (id === "u-fin") throw new Error("db caiu");
      return h.matrices[id] ?? {};
    });
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent.map((m) => m.to)).toEqual([["pm@jump"]]);
    expect(h.runs[0].results).toContainEqual({ userId: "u-fin", status: "FAILED", error: "db caiu" });
    expect(h.runs[0].status).toBe("FAILED");
  });

  it("visão ROLES compartilhada com PEOPLE: PEOPLE sem a entidade é pulado; FINANCE (papel fora) também", async () => {
    h.views.v1 = { ...h.views.v1, sharing: "ROLES", sharedRoles: ["PEOPLE"] };
    h.schedules = [schedule({ recipientUserIds: ["u-people", "u-fin"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.runs[0].results).toEqual([
      { userId: "u-people", status: "SKIPPED", reason: "sem_acesso_visao" },
      { userId: "u-fin", status: "SKIPPED", reason: "sem_acesso_visao" },
    ]);
  });

  it("spec adulterada no banco (campo inexistente) → pulado/registrado, nada enviado", async () => {
    h.views.v1 = { ...h.views.v1, spec: { ...hoursSpec, columns: ["data", "coluna_que_nao_existe\" OR 1=1"] } };
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.sqlValues).toHaveLength(0);
    for (const outcome of h.runs[0].results as Row[]) expect(outcome.status).not.toBe("SENT");
  });
});

describe("job (testador): autoridade do criador", () => {
  it.each([
    ["perdeu AGENDAR", () => { h.matrices["u-owner"] = grant(...READ, "CONSULTAS_CRIAR"); }],
    ["perdeu o módulo CONSULTAS (mantendo AGENDAR)", () => { h.matrices["u-owner"] = grant("CONSULTAS_AGENDAR", "CONSULTAS_HORAS"); }],
    ["ficou inativo", () => { h.users[0].status = "INACTIVE"; }],
    ["foi removido", () => { h.users = h.users.filter((u) => u.id !== "u-owner"); }],
  ])("criador %s → ninguém recebe; tudo registrado como criador_sem_permissao; sem consultar dados", async (_label, arrange) => {
    arrange();
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.sqlValues).toHaveLength(0);
    expect(h.resolveReportScope).not.toHaveBeenCalled();
    expect(h.runs[0]).toMatchObject({ status: "SKIPPED" });
    expect((h.runs[0].results as Row[]).every((o) => o.reason === "criador_sem_permissao")).toBe(true);
    expect(audits("CONSULTA_AGENDAMENTO_EXECUTADO")[0].after).toMatchObject({ status: "SKIPPED", sent: 0 });
  });

  it("alvo excluído → todos pulados (alvo_excluido)", async () => {
    h.views = {};
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect((h.runs[0].results as Row[]).every((o) => o.reason === "alvo_excluido")).toBe(true);
  });
});

describe("job (testador): idempotência por janela", () => {
  it("dois jobs CONCORRENTES na mesma janela: cada destinatário recebe uma vez só", async () => {
    const a = transport();
    const b = transport();
    const [ra, rb] = await Promise.all([
      runConsultaSchedules({ now: NOW, transport: a.t }),
      runConsultaSchedules({ now: new Date(NOW.getTime() + 1000), transport: b.t }),
    ]);
    const all = [...a.sent, ...b.sent].map((m) => m.to[0]).sort();
    expect(all).toEqual(["fin@jump", "pm@jump"]);
    expect(ra.processed + rb.processed).toBe(1);
    expect(ra.busy + rb.busy).toBe(1);
    expect(h.runs).toHaveLength(1);
  });

  it("retomada após crash (RUNNING com lease vencido e progresso salvo): quem já recebeu não recebe de novo", async () => {
    h.runs = [{
      id: "r1", scheduleId: "s1", windowKey: "2026-11-26T08", status: "RUNNING", attempts: 1,
      leaseUntil: new Date("2026-11-26T11:00:00Z"),
      results: [{ userId: "u-fin", status: "SENT", sheets: 1 }],
    }];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent.map((m) => m.to)).toEqual([["pm@jump"]]);
    expect(h.runs[0]).toMatchObject({ status: "SENT", attempts: 2 });
    expect(h.runs[0].results).toEqual([
      { userId: "u-fin", status: "SENT", sheets: 1 },
      { userId: "u-pm", status: "SENT", sheets: 1 },
    ]);
    // Quem já recebeu nem é reavaliado (nenhuma consulta com a permissão dele).
    expect((h.resolveReportScope.mock.calls as [AppUser][]).map(([u]) => u.id)).toEqual(["u-pm"]);
  });

  it("RUNNING com lease válido (outra instância trabalhando) → não assume e não envia", async () => {
    h.runs = [{ id: "r1", scheduleId: "s1", windowKey: "2026-11-26T08", status: "RUNNING", attempts: 1, leaseUntil: new Date("2026-11-26T12:05:00Z"), results: [] }];
    const { t, sent } = transport();
    expect(await runConsultaSchedules({ now: NOW, transport: t })).toMatchObject({ busy: 1, processed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("progresso é gravado após CADA destinatário (um crash no meio não reenvia ao primeiro)", async () => {
    const { t } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    // C3 correções 2/3: também grava (e confere a posse/renova o lease) antes de
    // gerar e logo antes de cada envio. O que importa: "u-fin SENT" é gravado
    // ANTES de qualquer trabalho para "u-pm".
    const progress = h.runUpdates.map((u) => JSON.stringify(u.results));
    const fin = JSON.stringify([{ userId: "u-fin", status: "SENT", sheets: 1 }]);
    const both = JSON.stringify([
      { userId: "u-fin", status: "SENT", sheets: 1 },
      { userId: "u-pm", status: "SENT", sheets: 1 },
    ]);
    expect(progress.indexOf(fin)).toBeGreaterThan(-1);
    expect(progress.indexOf(fin)).toBeLessThan(progress.indexOf(both));
    expect(progress.slice(0, progress.indexOf(fin)).every((p) => p === "[]")).toBe(true);
  });

  it("janela seguinte (outro dia) gera nova execução e novo envio", async () => {
    const first = transport();
    await runConsultaSchedules({ now: NOW, transport: first.t });
    const next = transport();
    await runConsultaSchedules({ now: new Date("2026-11-27T12:00:00Z"), transport: next.t });
    expect(h.runs.map((r) => r.windowKey)).toEqual(["2026-11-26T08", "2026-11-27T08"]);
    expect(next.sent).toHaveLength(2);
  });

  // Achado da C3 (corrigido): a janela era o MÊS; mudar o dia (5 → 20) após o
  // envio do dia 5 silenciava o dia 20. Agora a janela é a ocorrência (data+hora).
  it("[achado corrigido] mudar o dia do mensal após o envio do mês ainda envia a nova ocorrência no mesmo mês", async () => {
    h.schedules = [schedule({ frequency: "MONTHLY", monthDay: 5, recipientUserIds: ["u-fin"] })];
    const first = transport();
    await runConsultaSchedules({ now: new Date("2026-11-05T12:00:00Z"), transport: first.t });
    expect(first.sent).toHaveLength(1);
    // Dono muda para o dia 20 no dia 10 (activeSince reinicia, como faz updateSchedule).
    h.schedules = [schedule({ frequency: "MONTHLY", monthDay: 20, recipientUserIds: ["u-fin"], activeSince: new Date("2026-11-10T12:00:00Z") })];
    const second = transport();
    await runConsultaSchedules({ now: new Date("2026-11-20T12:00:00Z"), transport: second.t });
    expect(second.sent).toHaveLength(1);
  });

  it("lote: só `batch` execuções por chamada; as demais ficam para a próxima sem perder a janela", async () => {
    h.schedules = Array.from({ length: 5 }, (_, i) => schedule({ id: `s${i}`, recipientUserIds: ["u-fin"] }));
    const { t, sent } = transport();
    const first = await runConsultaSchedules({ now: NOW, transport: t, batch: 2 });
    expect(first).toMatchObject({ due: 5, processed: 2 });
    const second = await runConsultaSchedules({ now: NOW, transport: t, batch: 10 });
    expect(second).toMatchObject({ processed: 3, busy: 2 });
    expect(sent).toHaveLength(5);
  });
});

describe("job (testador): painel agendado — só o que o destinatário pode ver", () => {
  beforeEach(() => {
    h.views.vPriv = { id: "vPriv", ownerId: "u-other", name: "Margem Secreta Diretoria", entity: "horas", spec: hoursSpec, sharing: "PRIVATE", sharedRoles: [] };
    h.views.vFin = { id: "vFin", ownerId: "u-owner", name: "Receita Confidencial", entity: "horas", spec: { ...hoursSpec, columns: ["data", "valor_hora_venda"] }, sharing: "ALL", sharedRoles: [] };
    h.views.vPag = { id: "vPag", ownerId: "u-owner", name: "Pagamentos Ocultos", entity: "pagamentos", spec: { entity: "pagamentos", filters: null, columns: [], groupBy: [], measures: [], sort: [] }, sharing: "ALL", sharedRoles: [] };
    h.views.vOk = { id: "vOk", ownerId: "u-owner", name: "Horas Visíveis", entity: "horas", spec: { entity: "horas", filters: null, columns: [], groupBy: [{ field: "projeto" }], measures: [{ field: "horas", agg: "sum" }], sort: [] }, sharing: "ALL", sharedRoles: [] };
    h.panels.p1 = {
      id: "p1", ownerId: "u-owner", name: "Painel Gestão", sharing: "ALL", sharedRoles: [],
      items: ["v1", "vPriv", "vFin", "vPag", "vOk"].map((viewId) => ({ viewId, size: "normal" })),
    };
    h.schedules = [schedule({ viewId: null, panelId: "p1", recipientUserIds: ["u-pm"] })];
  });

  it("PM: abas só de v1 e vOk (+Totais); nomes das inacessíveis não aparecem na planilha, no e-mail nem na auditoria", async () => {
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(1);
    const { names, cells } = await workbookOf(sent[0]);
    expect(names.filter((n) => n !== "Totais")).toEqual(["Horas por consultor", "Horas Visíveis"]);
    const hidden = ["Margem Secreta Diretoria", "Receita Confidencial", "Pagamentos Ocultos"];
    const audited = JSON.stringify(h.recordAuditEvent.mock.calls);
    for (const name of hidden) {
      expect(names.join("|")).not.toContain(name);
      expect(cells).not.toContain(name);
      expect(sent[0].text).not.toContain(name);
      expect(sent[0].html ?? "").not.toContain(name);
      expect(sent[0].subject).not.toContain(name);
      expect(audited).not.toContain(name);
    }
    expect(h.runs[0].results).toEqual([{ userId: "u-pm", status: "SENT", sheets: 2, hiddenViews: 3 }]);
    // Coluna financeira nunca entrou em consulta do PM.
    expect(JSON.stringify(h.sqlValues)).not.toContain("valor_hora");
  });

  it("FINANCE (com finanças, sem Pagamentos na matriz deste teste): vê vFin, não vPriv nem vPag", async () => {
    h.schedules = [schedule({ viewId: null, panelId: "p1", recipientUserIds: ["u-fin"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    const { names } = await workbookOf(sent[0]);
    expect(names.filter((n) => n !== "Totais")).toEqual(["Horas por consultor", "Receita Confidencial", "Horas Visíveis"]);
    expect(names.join("|")).not.toMatch(/Margem Secreta|Pagamentos Ocultos/);
  });

  it("painel PRIVADO do criador: outro destinatário é pulado (sem_acesso_painel) e não recebe nada", async () => {
    h.panels.p1 = { ...h.panels.p1, sharing: "PRIVATE" };
    h.schedules = [schedule({ viewId: null, panelId: "p1", recipientUserIds: ["u-owner", "u-pm"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent.map((m) => m.to)).toEqual([["ana@jump"]]);
    expect(h.runs[0].results).toContainEqual({ userId: "u-pm", status: "SKIPPED", reason: "sem_acesso_painel" });
  });

  it("painel ROLES para FINANCE: PM é pulado mesmo que as visões sejam ALL", async () => {
    h.panels.p1 = { ...h.panels.p1, sharing: "ROLES", sharedRoles: ["FINANCE"] };
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.runs[0].results).toEqual([{ userId: "u-pm", status: "SKIPPED", reason: "sem_acesso_painel" }]);
  });

  it("nenhuma visão acessível → pulado (nenhuma_visao_acessivel), sem e-mail vazio", async () => {
    h.panels.p1 = { ...h.panels.p1, items: ["vPriv", "vFin", "vPag", "sumiu"].map((viewId) => ({ viewId, size: "normal" })) };
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.runs[0].results).toEqual([{ userId: "u-pm", status: "SKIPPED", reason: "nenhuma_visao_acessivel" }]);
  });
});

describe("job (testador): registro e e-mail sem dados", () => {
  it("auditoria da execução não traz e-mail, nome do alvo, linhas nem a spec", async () => {
    const { t } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    const executed = audits("CONSULTA_AGENDAMENTO_EXECUTADO");
    expect(executed).toHaveLength(1);
    expect(executed[0].actorUserId).toBeNull();
    const text = JSON.stringify(executed[0]);
    for (const leak of ["fin@jump", "pm@jump", "Horas por consultor", "Ana", "consultor", "2026-11-20"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("e-mail escapa HTML vindo do nome do agendamento/alvo (sem injeção no corpo)", () => {
    const email = buildConsultaAgendadaEmail({
      scheduleName: '<script>alert(1)</script>',
      targetKind: "view",
      targetName: '<img src=x onerror="alert(2)">',
      timing: "Todos os dias às 08:00",
      sheetCount: 1,
      hiddenViews: 0,
      truncated: false,
      link: null,
      recipientName: "<b>Ana</b>",
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Ana</b>");
  });

  it("nome de alvo com separadores de caminho não vira caminho no anexo", async () => {
    h.views.v1 = { ...h.views.v1, name: "../../etc/passwd" };
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent[0].attachments![0].filename).toBe("etc-passwd_2026-11-26.xlsx");
  });
});

describe("job (testador): sem sessão", () => {
  const SRC = path.resolve(__dirname);
  it("job e rota não importam guards/sessão (requireUser, auth(), getCurrentUser)", () => {
    const files = [
      path.join(SRC, "consultas-schedules.ts"),
      path.resolve(SRC, "../../app/api/jobs/consultas-agendadas/route.ts"),
    ];
    for (const file of files) {
      const code = readFileSync(file, "utf8");
      expect(code).not.toMatch(/@\/lib\/auth\/guards|@\/auth["']|getCurrentUser|requireUser|getCurrentMatrix|from "next-auth"/);
    }
  });
});
