import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";
import type { EmailMessage, EmailTransport } from "@/lib/automation/email-transport";

/**
 * Fase C3: envio agendado no servidor com Prisma/matriz mockados.
 * - execução com a permissão de CADA destinatário (nunca a do criador; a
 *   matriz da sessão nem é consultada pelo job);
 * - destinatário sem acesso pulado e registrado;
 * - idempotência por janela (run UNIQUE + claim/lease);
 * - retentativa não reenvia a quem já recebeu;
 * - cadastro: AGENDAR, dono, destinatários = usuários ativos, auditoria.
 */

type Row = Record<string, unknown>;

const h = vi.hoisted(() => ({
  users: [] as { id: string; name: string; email: string; status: string; roles: string[] }[],
  matrices: {} as Record<string, PermissionMatrix>,
  views: {} as Record<string, Row>,
  panels: {} as Record<string, Row>,
  schedules: [] as Row[],
  runs: [] as Row[],
  sqlValues: [] as unknown[][],
  /** Disparado uma vez após uma gravação de progresso que satisfaça o predicado. */
  afterProgress: undefined as undefined | { when: (results: unknown) => boolean; run: () => Promise<void> },
  /** Falha transitória (uma vez) numa gravação de progresso que satisfaça o predicado. */
  failProgress: undefined as undefined | ((results: unknown) => boolean),
  recordAuditEvent: vi.fn(async (input: unknown) => void input),
  getCurrentMatrix: vi.fn(),
  resolveDbUser: vi.fn(),
  scheduleCreate: vi.fn(),
  scheduleUpdate: vi.fn(),
  scheduleDelete: vi.fn(),
  getSavedViewForViewer: vi.fn(),
  getPanelForViewer: vi.fn(),
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
      return [{ c0: "2026-11-20", c1: "Ana", c2: 8 }];
    }),
  };
  const matchRun = (where: Row) =>
    h.runs.find((run) => run.scheduleId === where.scheduleId && run.windowKey === where.windowKey);
  return {
    Prisma: actual.Prisma,
    prisma: {
      $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
      user: {
        findMany: vi.fn(
          async ({ where, select }: { where: { id?: { in: string[] }; status?: string }; select?: Record<string, unknown> }) =>
            h.users
              .filter((u) => (!where.id || where.id.in.includes(u.id)) && (!where.status || u.status === where.status))
              .map((u) => ({ ...u, roles: u.roles.map((name) => ({ role: { name } })) }))
              .map((u) => (select ? Object.fromEntries(Object.keys(select).map((key) => [key, u[key as keyof typeof u]])) : u)),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.users.find((u) => u.id === where.id) ?? null),
        count: vi.fn(
          async ({ where }: { where: { id: { in: string[] }; status: string } }) =>
            h.users.filter((u) => where.id.in.includes(u.id) && u.status === where.status).length,
        ),
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
        findMany: vi.fn(async ({ where, take }: { where: { id?: { gt: string } }; take?: number }) =>
          h.schedules
            .filter((s) => s.active && (!where.id || (s.id as string) > where.id.gt))
            .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1))
            .slice(0, take ?? Infinity),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => h.schedules.find((s) => s.id === where.id) ?? null),
        create: h.scheduleCreate,
        update: h.scheduleUpdate,
        delete: h.scheduleDelete,
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
            if (h.failProgress && h.failProgress(data.results)) {
              h.failProgress = undefined;
              throw new Error("Can't reach database server (transitório)");
            }
            Object.assign(owned, data);
            const hook = h.afterProgress;
            if (hook && hook.when(data.results)) {
              h.afterProgress = undefined;
              await hook.run();
            }
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
          Object.assign(run, data);
          return run;
        }),
      },
    },
  };
});
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: h.recordAuditEvent }));
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix: h.getCurrentMatrix, can: vi.fn() }));
vi.mock("@/lib/auth/sensitive-data", () => ({ canAccessSensitiveCost: () => false }));
vi.mock("@/lib/db/permissions", () => ({
  loadPermissionMatrixForUser: vi.fn(async (id: string) => h.matrices[id] ?? {}),
}));
vi.mock("@/lib/db/users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/users")>("@/lib/db/users");
  return { mapPersistedRoles: actual.mapPersistedRoles, resolveDbUser: h.resolveDbUser };
});
vi.mock("@/lib/db/reports", () => ({
  // Escopo dos Relatórios simplificado: FINANCE/ADMIN amplo; PM = próprios projetos.
  resolveReportScope: vi.fn(async (user: AppUser, matrix?: PermissionMatrix) => {
    if (!matrix) throw new Error("o job precisa passar a matriz do destinatário");
    const broad = user.roles.some((role) => role === "ADMIN" || role === "FINANCE");
    return broad
      ? { broad: true, includeFinancials: true, financeHoursLimited: false }
      : { broad: false, managerUserId: user.id, includeFinancials: false, financeHoursLimited: false };
  }),
}));
vi.mock("@/lib/db/consultas-saved", () => ({
  getSavedViewForViewer: h.getSavedViewForViewer,
  getPanelForViewer: h.getPanelForViewer,
  listSavedViews: vi.fn(async () => ({ mine: [], shared: [] })),
  listPanels: vi.fn(async () => ({ mine: [], shared: [] })),
}));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { ConsultaError } from "@/lib/consultas/errors";
import {
  claimRun,
  createSchedule,
  deleteSchedule,
  getScheduleFormOptions,
  runConsultaSchedules,
  updateSchedule,
} from "./consultas-schedules";

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const READ = ["CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"];
const hoursSpec = { entity: "horas", filters: null, columns: ["data", "consultor", "horas"], groupBy: [], measures: [], sort: [] };

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

/** 26/11/2026 12:00Z = 09:00 em SP → a janela diária de 08:00 já venceu. */
const NOW = new Date("2026-11-26T12:00:00Z");
const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error as ConsultaError;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  h.users = [
    { id: "u-owner", name: "Ana Admin", email: "ana@jump", status: "ACTIVE", roles: ["ADMIN"] },
    { id: "u-fin", name: "Fábio Fin", email: "fin@jump", status: "ACTIVE", roles: ["FINANCE"] },
    { id: "u-pm", name: "Paula PM", email: "pm@jump", status: "ACTIVE", roles: ["PROJECT_MANAGER"] },
    { id: "u-noexp", name: "Sem Exportar", email: "noexp@jump", status: "ACTIVE", roles: ["PROJECT_MANAGER"] },
    { id: "u-noent", name: "Sem Horas", email: "noent@jump", status: "ACTIVE", roles: ["PEOPLE"] },
    { id: "u-off", name: "Inativo", email: "off@jump", status: "INACTIVE", roles: ["FINANCE"] },
  ];
  h.matrices = {
    "u-owner": grant(...READ, "CONSULTAS_AGENDAR", "CONSULTAS_CRIAR"),
    "u-fin": grant(...READ),
    "u-pm": grant(...READ),
    "u-noexp": grant("CONSULTAS", "CONSULTAS_HORAS"),
    "u-noent": grant("CONSULTAS", "CONSULTAS_EXPORTAR"),
    "u-off": grant(...READ),
  };
  h.views = {
    v1: { id: "v1", ownerId: "u-owner", name: "Horas por consultor", entity: "horas", spec: hoursSpec, sharing: "ALL", sharedRoles: [] },
  };
  h.panels = {};
  h.schedules = [schedule()];
  h.runs = [];
  h.sqlValues = [];
  h.afterProgress = undefined;
  h.failProgress = undefined;
  // O job não tem sessão: se alguém ler a matriz da sessão, é bug.
  h.getCurrentMatrix.mockRejectedValue(new Error("sem sessão no job"));
  h.resolveDbUser.mockImplementation(async (user: AppUser) => ({ id: user.id, name: user.name, email: user.email }));
});

describe("job: executa com a permissão de cada destinatário", () => {
  it("cada destinatário recebe o próprio arquivo; o PM com o escopo dele (não o do criador ADMIN)", async () => {
    const { t, sent } = transport();
    const summary = await runConsultaSchedules({ now: NOW, transport: t });
    expect(summary).toMatchObject({ due: 1, processed: 1, sent: 2, skipped: 0, failed: 0 });
    expect(sent.map((m) => m.to)).toEqual([["fin@jump"], ["pm@jump"]]);
    const attachment = sent[0].attachments![0];
    expect(attachment).toMatchObject({ encoding: "base64", filename: "Horas-por-consultor_2026-11-26.xlsx" });
    expect(Buffer.from(attachment.content, "base64").subarray(0, 2).toString()).toBe("PK");
    // Escopo do PM (project_manager_id = u-pm) apareceu como parâmetro nas consultas dele.
    expect(h.sqlValues.some((values) => values.includes("u-pm"))).toBe(true);
    expect(h.sqlValues.some((values) => values.includes("u-owner"))).toBe(false);
    expect(h.getCurrentMatrix).not.toHaveBeenCalled();
    // Exportação auditada com o destinatário como ator e o agendamento.
    const exports = h.recordAuditEvent.mock.calls
      .map((call) => call[0] as { action: string; actorUserId: string; after: Row })
      .filter((event) => event.action === "CONSULTA_EXPORTADA");
    expect(exports.map((e) => e.actorUserId)).toEqual(["u-fin", "u-pm"]);
    expect(exports[0].after).toMatchObject({ origin: "saved_view", viewId: "v1", scheduleId: "s1" });
    expect(h.runs[0]).toMatchObject({ status: "SENT", windowKey: "2026-11-26T08" });
  });

  it("sem exportar, sem a entidade, inativo ou visão privada alheia → pulado e registrado, sem consulta", async () => {
    h.schedules = [schedule({ recipientUserIds: ["u-noexp", "u-noent", "u-off", "u-gone"] })];
    const { t, sent } = transport();
    const summary = await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(summary).toMatchObject({ sent: 0, skipped: 4 });
    expect(h.sqlValues).toHaveLength(0);
    expect(h.runs[0].status).toBe("SKIPPED");
    expect(h.runs[0].results).toEqual([
      { userId: "u-noexp", status: "SKIPPED", reason: "sem_permissao_exportar" },
      { userId: "u-noent", status: "SKIPPED", reason: "sem_acesso_visao" },
      { userId: "u-off", status: "SKIPPED", reason: "usuario_inativo" },
      { userId: "u-gone", status: "SKIPPED", reason: "usuario_inativo" },
    ]);
    const executed = h.recordAuditEvent.mock.calls
      .map((call) => call[0] as { action: string; after: Row })
      .find((event) => event.action === "CONSULTA_AGENDAMENTO_EXECUTADO")!;
    expect(executed.after).toMatchObject({ status: "SKIPPED", skipped: 4 });
  });

  it("visão PRIVADA do criador não chega a outro destinatário (nunca usa a permissão do dono)", async () => {
    h.views.v1 = { ...h.views.v1, sharing: "PRIVATE" };
    h.schedules = [schedule({ recipientUserIds: ["u-owner", "u-fin"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent.map((m) => m.to)).toEqual([["ana@jump"]]);
    expect(h.runs[0].results).toContainEqual({ userId: "u-fin", status: "SKIPPED", reason: "sem_acesso_visao" });
  });

  it("campo financeiro: Financeiro recebe; PM é pulado (campo sem permissão)", async () => {
    h.views.v1 = { ...h.views.v1, spec: { ...hoursSpec, columns: ["data", "consultor", "valor_hora_venda"] } };
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent.map((m) => m.to)).toEqual([["fin@jump"]]);
    expect(h.runs[0]).toMatchObject({ status: "PARTIAL" });
    expect(h.runs[0].results).toContainEqual({ userId: "u-pm", status: "SKIPPED", reason: "campo_sem_permissao" });
  });

  it("criador sem AGENDAR (ou inativo) suspende o envio", async () => {
    h.matrices["u-owner"] = grant(...READ);
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(0);
    expect(h.runs[0].results).toEqual([
      { userId: "u-fin", status: "SKIPPED", reason: "criador_sem_permissao" },
      { userId: "u-pm", status: "SKIPPED", reason: "criador_sem_permissao" },
    ]);
  });

  it("painel: uma aba por visão acessível; as demais só contam", async () => {
    h.views.v2 = { id: "v2", ownerId: "u-other", name: "Privada de outro", entity: "horas", spec: hoursSpec, sharing: "PRIVATE", sharedRoles: [] };
    h.views.v3 = { id: "v3", ownerId: "u-owner", name: "Horas (2)", entity: "horas", spec: hoursSpec, sharing: "ALL", sharedRoles: [] };
    h.panels.p1 = {
      id: "p1",
      ownerId: "u-owner",
      name: "Painel semanal",
      sharing: "ALL",
      sharedRoles: [],
      items: [{ viewId: "v1", size: "normal" }, { viewId: "v2", size: "normal" }, { viewId: "v3", size: "largo" }, { viewId: "sumiu", size: "normal" }],
    };
    h.schedules = [schedule({ viewId: null, panelId: "p1", recipientUserIds: ["u-pm"] })];
    const { t, sent } = transport();
    await runConsultaSchedules({ now: NOW, transport: t });
    expect(sent).toHaveLength(1);
    expect(h.runs[0].results).toEqual([{ userId: "u-pm", status: "SENT", sheets: 2, hiddenViews: 2 }]);
    expect(sent[0].text).toContain("2 visão(ões) deste painel não entraram");
    expect(sent[0].text).not.toContain("Privada de outro");
  });
});

describe("job: idempotência por janela e claim", () => {
  it("percorre TODOS os agendamentos ativos (paginado por id, sem teto de 1000)", async () => {
    h.schedules = Array.from({ length: 1203 }, (_, i) => schedule({ id: `s${String(i).padStart(5, "0")}` }));
    const { t } = transport();
    const summary = await runConsultaSchedules({ now: NOW, transport: t, batch: 0 });
    expect(summary).toMatchObject({ checked: 1203, due: 1203, processed: 0 });
  });

  it("segunda chamada na mesma janela não reenvia", async () => {
    const first = transport();
    await runConsultaSchedules({ now: NOW, transport: first.t });
    const second = transport();
    const summary = await runConsultaSchedules({ now: new Date("2026-11-26T12:15:00Z"), transport: second.t });
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(0);
    expect(summary).toMatchObject({ due: 1, processed: 0, busy: 1 });
    expect(h.runs).toHaveLength(1);
  });

  it("mudar a hora no mesmo dia após o envio: a nova ocorrência sai; a já enviada não repete", async () => {
    const first = transport();
    await runConsultaSchedules({ now: NOW, transport: first.t });
    expect(first.sent).toHaveLength(2);
    // Dono muda 08h → 10h às 09:30 (activeSince reinicia, como em updateSchedule).
    h.schedules = [schedule({ hour: 10, activeSince: new Date("2026-11-26T12:30:00Z") })];
    const before = transport();
    expect(await runConsultaSchedules({ now: new Date("2026-11-26T12:45:00Z"), transport: before.t })).toMatchObject({ due: 0 });
    const after = transport();
    await runConsultaSchedules({ now: new Date("2026-11-26T13:05:00Z"), transport: after.t });
    expect(after.sent).toHaveLength(2);
    const again = transport();
    await runConsultaSchedules({ now: new Date("2026-11-26T13:20:00Z"), transport: again.t });
    expect(again.sent).toHaveLength(0);
    expect(h.runs.map((run) => run.windowKey)).toEqual(["2026-11-26T08", "2026-11-26T10"]);
  });

  it("antes da hora, ou antes de activeSince, nada é devido", async () => {
    const { t, sent } = transport();
    expect(await runConsultaSchedules({ now: new Date("2026-11-26T10:30:00Z"), transport: t })).toMatchObject({ due: 1 });
    expect(h.runs[0].windowKey).toBe("2026-11-25T08");
    h.runs = [];
    h.schedules = [schedule({ activeSince: new Date("2026-11-26T11:30:00Z") })];
    sent.length = 0;
    expect(await runConsultaSchedules({ now: NOW, transport: t })).toMatchObject({ due: 0, processed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("lease vencido com o worker antigo ainda rodando: ninguém recebe duas vezes e o antigo não sobrescreve o novo", async () => {
    const oldWorker = transport();
    const newWorker = transport();
    let newSummary: unknown = null;
    // Depois que o worker antigo grava "u-fin recebeu", ele "trava" por 11 min:
    // o cron seguinte encontra o lease vencido e assume a janela.
    h.afterProgress = {
      when: (results) => Array.isArray(results) && results.length === 1 && (results[0] as Row).status === "SENT",
      run: async () => {
        newSummary = await runConsultaSchedules({ now: new Date(NOW.getTime() + 11 * 60_000), transport: newWorker.t });
      },
    };
    const oldSummary = await runConsultaSchedules({ now: NOW, transport: oldWorker.t, clock: () => NOW });
    expect(oldWorker.sent.map((m) => m.to)).toEqual([["fin@jump"]]);
    expect(newWorker.sent.map((m) => m.to)).toEqual([["pm@jump"]]);
    expect(newSummary).toMatchObject({ processed: 1, sent: 2 });
    expect(oldSummary).toMatchObject({ lost: 1 });
    // O run final é o do worker novo (SENT, 2 tentativas, token liberado).
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ status: "SENT", attempts: 2, claimToken: null });
    expect(h.runs[0].results).toEqual([
      { userId: "u-fin", status: "SENT", sheets: 1 },
      { userId: "u-pm", status: "SENT", sheets: 1 },
    ]);
    const executed = h.recordAuditEvent.mock.calls.filter((call) => (call[0] as { action: string }).action === "CONSULTA_AGENDAMENTO_EXECUTADO");
    expect(executed).toHaveLength(1);
  });

  it("falha transitória do Prisma logo após um envio: quem recebeu fica SENT e não é reenviado no retry", async () => {
    h.failProgress = (results) =>
      Array.isArray(results) && results.length === 1 && (results[0] as Row).status === "SENT";
    const first = transport();
    await runConsultaSchedules({ now: NOW, transport: first.t });
    expect(first.sent.map((m) => m.to)).toEqual([["fin@jump"]]);
    expect(h.runs[0].status).toBe("FAILED");
    expect(h.runs[0].results).toEqual([
      { userId: "u-fin", status: "SENT", sheets: 1 },
      { userId: "u-pm", status: "FAILED", error: "falha ao processar" },
    ]);
    const retry = transport();
    await runConsultaSchedules({ now: new Date("2026-11-26T12:15:00Z"), transport: retry.t });
    expect(retry.sent.map((m) => m.to)).toEqual([["pm@jump"]]);
    expect(h.runs[0]).toMatchObject({ status: "SENT", attempts: 2 });
  });

  it("posse conferida logo antes do send: run reassumido durante a geração → nada é enviado", async () => {
    const oldWorker = transport();
    // Assim que o worker antigo grava o progresso inicial (antes de gerar), o
    // run é reassumido por outro token (simula lease vencido + novo claim).
    h.afterProgress = {
      when: (results) => Array.isArray(results) && results.length === 0,
      run: async () => {
        h.runs[0].claimToken = "outro-worker";
      },
    };
    const summary = await runConsultaSchedules({ now: NOW, transport: oldWorker.t });
    expect(oldWorker.sent).toHaveLength(0);
    expect(summary).toMatchObject({ lost: 1, sent: 0 });
    expect(h.runs[0]).toMatchObject({ status: "RUNNING", claimToken: "outro-worker" });
  });

  it("claim: RUNNING com lease válido não é assumido; vencido é; FAILED é retentado até o teto", async () => {
    h.runs = [{ id: "r1", scheduleId: "s1", windowKey: "2026-11-26T08", status: "RUNNING", attempts: 1, leaseUntil: new Date("2026-11-26T12:05:00Z"), results: null }];
    expect(await claimRun("s1", "2026-11-26T08", NOW)).toBeNull();
    expect(await claimRun("s1", "2026-11-26T08", new Date("2026-11-26T12:06:00Z"))).toMatchObject({ runId: "r1" });
    h.runs[0] = { ...h.runs[0], status: "FAILED", attempts: 3 };
    expect(await claimRun("s1", "2026-11-26T08", NOW)).toBeNull();
    h.runs[0] = { ...h.runs[0], status: "SENT", attempts: 1 };
    expect(await claimRun("s1", "2026-11-26T08", NOW)).toBeNull();
  });

  it("falha de entrega → FAILED; a retentativa só envia a quem ainda não recebeu", async () => {
    const flaky = transport();
    (flaky.t.send as ReturnType<typeof vi.fn>).mockImplementationOnce(async (message: EmailMessage) => {
      flaky.sent.push(message);
      return { id: "ok", provider: "test" };
    });
    (flaky.t.send as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      throw new Error("Resend send failed (500)");
    });
    await runConsultaSchedules({ now: NOW, transport: flaky.t });
    expect(h.runs[0].status).toBe("FAILED");
    expect(h.runs[0].results).toEqual([
      { userId: "u-fin", status: "SENT", sheets: 1 },
      { userId: "u-pm", status: "FAILED", error: "Resend send failed (500)" },
    ]);
    const retry = transport();
    await runConsultaSchedules({ now: new Date("2026-11-26T12:15:00Z"), transport: retry.t });
    expect(retry.sent.map((m) => m.to)).toEqual([["pm@jump"]]);
    expect(h.runs[0]).toMatchObject({ status: "SENT", attempts: 2 });
  });
});

describe("cadastro de agendamento", () => {
  const owner: AppUser = { id: "u-owner", name: "Ana Admin", email: "ana@jump", roles: ["ADMIN"] };
  const pm: AppUser = { id: "u-pm", name: "Paula PM", email: "pm@jump", roles: ["PROJECT_MANAGER"] };
  const input = {
    name: "Horas",
    target: { kind: "view", id: "v1" },
    frequency: "DAILY",
    hour: 8,
    recipientUserIds: ["u-fin", "u-pm"],
    active: true,
  };

  beforeEach(() => {
    h.getCurrentMatrix.mockImplementation(async () => h.matrices[currentUser]);
    h.getSavedViewForViewer.mockResolvedValue({ summary: { available: true }, spec: hoursSpec });
    h.scheduleCreate.mockResolvedValue({ id: "novo" });
  });
  let currentUser = "u-owner";

  it("cria com AGENDAR, alvo aberto e usuários ativos; audita", async () => {
    currentUser = "u-owner";
    expect(await createSchedule(owner, input, NOW)).toBe("novo");
    expect(h.scheduleCreate.mock.calls[0][0].data).toMatchObject({ ownerId: "u-owner", viewId: "v1", panelId: null, weekday: null, activeSince: NOW });
    const audit = h.recordAuditEvent.mock.calls.map((call) => call[0] as { action: string })[0];
    expect(audit).toMatchObject({ action: "CONSULTA_AGENDAMENTO_CRIADO", entityType: "ConsultaSchedule", entityId: "novo" });
  });

  it("sem AGENDAR → FORBIDDEN; destinatário inativo/externo → INVALID; alvo fechado → INVALID", async () => {
    currentUser = "u-pm";
    expect((await errorOf(createSchedule(pm, input, NOW)))?.code).toBe("FORBIDDEN");
    currentUser = "u-owner";
    expect((await errorOf(createSchedule(owner, { ...input, recipientUserIds: ["u-off"] }, NOW)))?.code).toBe("INVALID");
    expect((await errorOf(createSchedule(owner, { ...input, recipientUserIds: ["x@externo.com"] }, NOW)))?.code).toBe("INVALID");
    h.getSavedViewForViewer.mockResolvedValue(null);
    expect((await errorOf(createSchedule(owner, input, NOW)))?.code).toBe("INVALID");
    expect(h.scheduleCreate).not.toHaveBeenCalled();
  });

  it("alterar/excluir: só o dono (NOT_FOUND para os demais); mudar horário reinicia activeSince", async () => {
    currentUser = "u-fin";
    h.matrices["u-fin"] = grant(...READ, "CONSULTAS_AGENDAR");
    const fin: AppUser = { id: "u-fin", name: "Fábio", email: "fin@jump", roles: ["FINANCE"] };
    expect((await errorOf(updateSchedule(fin, "s1", input, NOW)))?.code).toBe("NOT_FOUND");
    expect((await errorOf(deleteSchedule(fin, "s1")))?.code).toBe("NOT_FOUND");
    currentUser = "u-owner";
    await updateSchedule(owner, "s1", { ...input, hour: 9 }, NOW);
    expect(h.scheduleUpdate.mock.calls[0][0].data).toMatchObject({ hour: 9, activeSince: NOW });
    await updateSchedule(owner, "s1", { ...input, name: "Outro nome" }, NOW);
    expect(h.scheduleUpdate.mock.calls[1][0].data).not.toHaveProperty("activeSince");
    await deleteSchedule(owner, "s1");
    const actions = h.recordAuditEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
    expect(actions).toEqual(["CONSULTA_AGENDAMENTO_ATUALIZADO", "CONSULTA_AGENDAMENTO_ATUALIZADO", "CONSULTA_AGENDAMENTO_EXCLUIDO"]);
  });

  it("opções do formulário: usuários ativos só com id + nome (sem e-mail)", async () => {
    currentUser = "u-owner";
    const options = await getScheduleFormOptions(owner);
    expect(options.users.length).toBeGreaterThan(0);
    expect(options.users.map((user) => user.id)).not.toContain("u-off");
    for (const user of options.users) expect(Object.keys(user).sort()).toEqual(["id", "name"]);
    expect(JSON.stringify(options)).not.toContain("@jump");
  });

  it("dono que perdeu AGENDAR ainda exclui, mas não altera", async () => {
    currentUser = "u-owner";
    h.matrices["u-owner"] = grant(...READ);
    expect((await errorOf(updateSchedule(owner, "s1", input, NOW)))?.code).toBe("FORBIDDEN");
    await deleteSchedule(owner, "s1");
    expect(h.scheduleDelete).toHaveBeenCalledTimes(1);
  });
});
