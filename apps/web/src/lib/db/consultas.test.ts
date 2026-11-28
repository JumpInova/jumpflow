import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

const {
  executeRaw,
  queryRaw,
  transaction,
  recordAuditEvent,
  getCurrentMatrix,
  resolveReportScope,
} = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  recordAuditEvent: vi.fn(async (input: unknown) => void input),
  getCurrentMatrix: vi.fn<() => Promise<PermissionMatrix>>(),
  resolveReportScope: vi.fn(),
}));

vi.mock("@jumpflow/database", async () => {
  const actual = await vi.importActual<typeof import("@jumpflow/database")>(
    "@jumpflow/database",
  );
  return {
    Prisma: actual.Prisma,
    prisma: { $transaction: (...args: unknown[]) => transaction(...args) },
  };
});
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent }));
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix }));
vi.mock("@/lib/db/reports", () => ({ resolveReportScope }));
vi.mock("@/lib/auth/sensitive-data", () => ({
  canAccessSensitiveCost: (u: AppUser | null) => Boolean(u?.roles.includes("SENSITIVE_DATA")),
}));
vi.mock("@/lib/db/users", () => ({
  resolveDbUser: vi.fn(async () => ({ id: "db-user", name: "X", email: "x@jump" })),
}));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { exportConsulta, getConsultaContext, runConsulta } from "./consultas";

const user: AppUser = { id: "u1", name: "Gestora", email: "g@jump", roles: ["PROJECT_MANAGER"] } as AppUser;

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const spec = {
  entity: "horas",
  filters: null,
  columns: ["data", "consultor", "horas"],
  groupBy: [],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [],
};

beforeEach(() => {
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  );
  queryRaw.mockImplementation(async (sql: { text: string }) => {
    if (sql.text.includes('AS "total"')) return [{ total: 2 }];
    if (sql.text.startsWith("SELECT SUM")) return [{ m0: { toNumber: () => 16, toString: () => "16" } }];
    return [
      { c0: new Date("2026-11-03T00:00:00Z"), c1: "Ana", c2: { toNumber: () => 8, toString: () => "8" }, _detail: "c-1" },
      { c0: new Date("2026-11-04T00:00:00Z"), c1: "Ana", c2: { toNumber: () => 8, toString: () => "8" }, _detail: "c-1" },
    ];
  });
  resolveReportScope.mockResolvedValue({
    broad: false,
    managerUserId: "pm-db",
    includeFinancials: false,
    financeHoursLimited: false,
  });
});

afterEach(() => vi.clearAllMocks());

describe("getConsultaContext", () => {
  it("deriva acesso da matriz e escopo dos Relatórios", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    const context = await getConsultaContext(user);
    expect([...context.access.entities]).toEqual(["horas"]);
    expect(context.access.financial).toBe(false);
    expect(context.scope).toEqual({
      broad: false,
      managerUserId: "pm-db",
      ownConsultantId: undefined,
      financeHoursLimited: false,
    });
  });

  it("falha fechada quando a matriz não pode ser lida", async () => {
    getCurrentMatrix.mockRejectedValue(new Error("db down"));
    const context = await getConsultaContext(user);
    expect(context.access.module).toBe(false);
    expect(context.scope.broad).toBe(false);
  });
});

describe("runConsulta", () => {
  it("executa com SET LOCAL statement_timeout dentro da transação, com escopo", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    const result = await runConsulta(user, spec, 1);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0][0].text).toBe("SET LOCAL statement_timeout = '15s'");
    const rowsSql = queryRaw.mock.calls[0][0];
    expect(rowsSql.text).toContain('WHERE ("project_manager_id" = $1)');
    expect(rowsSql.values[0]).toBe("pm-db");

    expect(result.rows[0]).toMatchObject({ data: "2026-11-03", consultor: "Ana", horas: 8, _href: "/app/consultores/c-1" });
    expect(result.totals).toEqual({ "sum:horas": 16 });
    expect(result).toMatchObject({ totalRows: 2, navigableRows: 2, page: 1, pageCount: 1 });
    // Campos públicos: sem auditoria de execução.
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("sem CONSULTAS_CRIAR é recusada antes de tocar o banco", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS"));
    await expect(runConsulta(user, spec)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("campo financeiro sem a regra financeira é FORBIDDEN (não mascarado)", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    await expect(
      runConsulta(user, { ...spec, columns: ["data", "receita"] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("execução com campo financeiro é auditada", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    resolveReportScope.mockResolvedValue({ broad: true, includeFinancials: true, financeHoursLimited: false });
    await runConsulta(user, { ...spec, columns: ["data", "receita"] });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CONSULTA_EXECUTADA_SENSIVEL",
        entityType: "Consulta",
        entityId: "horas",
        actorUserId: "db-user",
      }),
    );
  });

  it("timeout do Postgres vira erro amigável", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    transaction.mockRejectedValue(new Error("ERROR: canceling statement due to statement timeout"));
    await expect(runConsulta(user, spec)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("exportConsulta", () => {
  it("exige CONSULTAS_EXPORTAR", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    await expect(exportConsulta(user, spec, "csv", "adhoc")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("CRIAR só é exigido para spec ad hoc; visão salva (C2) exporta com EXPORTAR + entidade", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"));
    await expect(exportConsulta(user, spec, "csv", "adhoc")).rejects.toMatchObject({ code: "FORBIDDEN" });
    const data = await exportConsulta(user, spec, "csv", "saved_view");
    expect(data.rows).toHaveLength(2);
    // Mesmo sem CRIAR, entidade e campos continuam exigidos.
    await expect(
      exportConsulta(user, { ...spec, entity: "alocacoes", columns: ["consultor"] }, "csv", "saved_view"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      exportConsulta(user, { ...spec, columns: ["receita"] }, "csv", "saved_view"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Financeiro não vê horas_lancadas de Alocações (recorte APPROVED/CLOSED)", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_ALOCACOES", "CONSULTAS_CRIAR"));
    resolveReportScope.mockResolvedValue({ broad: true, includeFinancials: true, financeHoursLimited: true });
    const context = await getConsultaContext(user);
    expect(context.access.financeHoursLimited).toBe(true);
    await expect(
      runConsulta(user, { ...spec, entity: "alocacoes", columns: ["consultor", "horas_lancadas"], measures: [] }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      runConsulta(user, { ...spec, entity: "alocacoes", columns: ["consultor", "horas_aprovadas"], measures: [] }),
    ).resolves.toBeDefined();
  });

  it("exporta até 50.000 linhas e sempre audita", async () => {
    getCurrentMatrix.mockResolvedValue(
      grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR"),
    );
    const data = await exportConsulta(user, spec, "xlsx", "adhoc");
    const rowsSql = queryRaw.mock.calls[0][0];
    expect(rowsSql.values.slice(-2)).toEqual([50_000, 0]);
    expect(data.rows).toHaveLength(2);
    expect(data.truncated).toBe(false);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CONSULTA_EXPORTADA",
        after: expect.objectContaining({ format: "xlsx", origin: "adhoc", rowCount: 2 }),
      }),
    );
  });
});
