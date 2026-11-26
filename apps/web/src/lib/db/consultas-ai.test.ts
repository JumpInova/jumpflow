import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

/**
 * Fase C3: assistente de IA no servidor — permissão, provider indisponível,
 * rate limit PERSISTIDO (SQL atômico, nada em memória) e auditoria sem o texto.
 */

const h = vi.hoisted(() => ({
  matrix: {} as PermissionMatrix,
  minuteCount: 0,
  hourTotal: 0,
  sql: [] as { text: string; values: unknown[] }[],
  configured: true,
  complete: vi.fn(),
  recordAuditEvent: vi.fn(async (input: unknown) => void input),
  deleteMany: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@jumpflow/database", async () => {
  const actual = await vi.importActual<typeof import("@jumpflow/database")>("@jumpflow/database");
  return {
    Prisma: actual.Prisma,
    prisma: {
      $queryRaw: vi.fn(async (sql: { strings: readonly string[]; values: unknown[] }) => {
        const text = sql.strings.join("$?");
        h.sql.push({ text, values: sql.values });
        if (text.includes("SUM(")) return [{ total: BigInt(h.hourTotal) }];
        // UPSERT condicional: no limite não incrementa e não devolve linha.
        if (text.includes('"count" <') && h.minuteCount >= Number(sql.values.at(-1))) return [];
        h.minuteCount += 1;
        return [{ count: h.minuteCount }];
      }),
      consultaAiUsage: { deleteMany: h.deleteMany },
    },
  };
});
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix: vi.fn(async () => h.matrix), can: vi.fn() }));
vi.mock("@/lib/auth/sensitive-data", () => ({ canAccessSensitiveCost: () => false }));
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: h.recordAuditEvent }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => ({ id: "db-pm", name: "Paula", email: "pm@jump" })) }));
vi.mock("@/lib/db/reports", () => ({
  resolveReportScope: vi.fn(async () => ({ broad: false, managerUserId: "db-pm", includeFinancials: false, financeHoursLimited: false })),
}));
vi.mock("@/lib/ai/provider", () => ({
  isAiProviderConfigured: () => h.configured,
  getConfiguredAiModel: () => "deepseek-flash",
  getAiTextProvider: () => ({ complete: h.complete, completeWithDocument: vi.fn(async () => null) }),
}));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { ConsultaError } from "@/lib/consultas/errors";
import { AI_RATE_LIMIT, assistConsulta, minuteWindow } from "./consultas-ai";

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const pm: AppUser = { id: "auth-pm", name: "Paula", email: "pm@jump", roles: ["PROJECT_MANAGER"] };
const SECRET_REQUEST = "horas do projeto Cliente Sigiloso por consultor";
const spec = {
  entity: "horas",
  filters: null,
  columns: [],
  groupBy: [{ field: "projeto" }],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [],
};
const NOW = new Date("2026-11-26T12:00:30Z");

beforeEach(() => {
  vi.clearAllMocks();
  h.matrix = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_IA");
  h.minuteCount = 0;
  h.hourTotal = 0;
  h.sql = [];
  h.configured = true;
  h.complete.mockResolvedValue(JSON.stringify(spec));
});

describe("assistente: permissão e disponibilidade", () => {
  it("sem CONSULTAS_IA, ou com IA mas sem CRIAR → FORBIDDEN, sem consumir cota", async () => {
    h.matrix = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR");
    await expect(assistConsulta(pm, SECRET_REQUEST, NOW)).rejects.toBeInstanceOf(ConsultaError);
    h.matrix = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_IA");
    await expect(assistConsulta(pm, SECRET_REQUEST, NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.sql).toHaveLength(0);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("provider não configurado → indisponível (construtor segue), sem chamar nada", async () => {
    h.configured = false;
    expect(await assistConsulta(pm, SECRET_REQUEST, NOW)).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(h.sql).toHaveLength(0);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("PM sem financeiro pede receita: IA responde fora do catálogo → CANNOT_ANSWER com mensagem fixa (não cita o campo)", async () => {
    h.complete.mockResolvedValue('{"error":"não há campo receita"}');
    const result = await assistConsulta(pm, "receita por projeto", NOW);
    expect(result).toMatchObject({ ok: false, code: "CANNOT_ANSWER" });
    expect(JSON.stringify(result)).not.toMatch(/receita/i);
    expect(h.complete).toHaveBeenCalledTimes(1);
    expect(h.complete.mock.calls[0][0]).not.toContain('"key":"receita"');
  });

  it("sucesso: spec validada + explicação; audita SEM o texto do usuário", async () => {
    const result = await assistConsulta(pm, SECRET_REQUEST, NOW);
    expect(result).toMatchObject({ ok: true, entityLabel: "Horas" });
    const audits = JSON.stringify(h.recordAuditEvent.mock.calls);
    expect(audits).toContain("CONSULTA_IA_USADA");
    expect(audits).not.toContain("Sigiloso");
    expect(audits).not.toContain(SECRET_REQUEST);
    expect(h.recordAuditEvent.mock.calls[0][0]).toMatchObject({ actorUserId: "db-pm", after: { outcome: "ok", attempts: 1, entity: "horas" } });
  });
});

describe("assistente: rate limit persistido no banco", () => {
  it("contador por minuto via INSERT ... ON CONFLICT ... RETURNING, com valores parametrizados", async () => {
    await assistConsulta(pm, SECRET_REQUEST, NOW);
    const insert = h.sql.find((q) => q.text.includes("INSERT INTO"))!;
    expect(insert.text).toContain('ON CONFLICT ("userId", "windowStart")');
    expect(insert.text).toContain("RETURNING");
    expect(insert.values).toContain("db-pm");
    expect(insert.values).toContainEqual(minuteWindow(NOW));
    expect(minuteWindow(NOW).toISOString()).toBe("2026-11-26T12:00:00.000Z");
    expect(JSON.stringify(h.sql)).not.toContain("Sigiloso");
  });

  it(`a partir do ${AI_RATE_LIMIT.perMinute + 1}º pedido no minuto → RATE_LIMITED sem chamar a IA`, async () => {
    for (let i = 0; i < AI_RATE_LIMIT.perMinute; i++) {
      expect((await assistConsulta(pm, SECRET_REQUEST, NOW)).ok).toBe(true);
    }
    h.complete.mockClear();
    const blocked = await assistConsulta(pm, SECRET_REQUEST, NOW);
    expect(blocked).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    if (!blocked.ok) expect(blocked.error).toMatch(/30 segundos/);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("pedido bloqueado no minuto NÃO incrementa (não consome a cota da hora)", async () => {
    h.minuteCount = AI_RATE_LIMIT.perMinute;
    for (let i = 0; i < 3; i++) {
      expect(await assistConsulta(pm, SECRET_REQUEST, NOW)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    }
    expect(h.minuteCount).toBe(AI_RATE_LIMIT.perMinute);
    const insert = h.sql.find((q) => q.text.includes("INSERT INTO"))!;
    expect(insert.text).toContain('WHERE "ConsultaAiUsage"."count" <');
    expect(insert.values).toContain(AI_RATE_LIMIT.perMinute);
  });

  it("teto por hora bloqueia antes de incrementar", async () => {
    h.hourTotal = AI_RATE_LIMIT.perHour;
    expect(await assistConsulta(pm, SECRET_REQUEST, NOW)).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(h.sql.some((q) => q.text.includes("INSERT INTO"))).toBe(false);
    expect(h.complete).not.toHaveBeenCalled();
  });

  it("pedido vazio/curto não consome cota", async () => {
    expect(await assistConsulta(pm, "  a ", NOW)).toMatchObject({ ok: false, code: "INVALID" });
    expect(h.sql).toHaveLength(0);
  });

  it("saída proibida duas vezes → desiste; usa 1 unidade de cota por pedido (não por tentativa)", async () => {
    h.complete.mockResolvedValue(JSON.stringify({ ...spec, columns: ["valor_hora_venda"], groupBy: [], measures: [] }));
    expect(await assistConsulta(pm, SECRET_REQUEST, NOW)).toMatchObject({ ok: false, code: "GAVE_UP" });
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(h.minuteCount).toBe(1);
  });
});
