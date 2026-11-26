import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

/**
 * Server action `executarConsulta` (Fase C1, testador) sobre o caminho REAL
 * `runConsulta`, com Prisma/matriz/escopo mockados: mapeamento de erros,
 * construtor exige CONSULTAS_CRIAR, escopo sem universo, paginação e link
 * de detalhe.
 */

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

let databaseConfigured = true;
const currentUser = { id: "u1", name: "P", email: "p@jump", roles: ["PEOPLE"] } as AppUser;

vi.mock("@/lib/auth/guards", () => ({ requireUser: vi.fn(async () => currentUser) }));
vi.mock("@/lib/db/config", () => ({ isDatabaseConfigured: () => databaseConfigured }));
vi.mock("@jumpflow/database", async () => {
  const actual = await vi.importActual<typeof import("@jumpflow/database")>("@jumpflow/database");
  return {
    Prisma: actual.Prisma,
    prisma: { $transaction: (...args: unknown[]) => transaction(...args) },
  };
});
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent }));
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix }));
vi.mock("@/lib/db/reports", () => ({ resolveReportScope }));
vi.mock("@/lib/auth/sensitive-data", () => ({ canAccessSensitiveCost: () => false }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => ({ id: "db-user" })) }));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { executarConsulta } from "./actions";

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const spec = {
  entity: "consultores",
  filters: null,
  columns: ["nome"],
  groupBy: [],
  measures: [],
  sort: [],
};

beforeEach(() => {
  databaseConfigured = true;
  getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_CONSULTORES", "CONSULTAS_CRIAR"));
  resolveReportScope.mockResolvedValue({ broad: true, includeFinancials: false, financeHoursLimited: false });
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  );
  queryRaw.mockImplementation(async (sql: { text: string }) => {
    if (sql.text.includes('AS "total"')) return [{ total: 5000 }];
    return [{ c0: "Ana", _detail: "../admin?x=1" }];
  });
});

afterEach(() => vi.clearAllMocks());

describe("executarConsulta", () => {
  it("sem banco → NO_DATABASE, sem executar", async () => {
    databaseConfigured = false;
    expect(await executarConsulta(spec, 1)).toMatchObject({ ok: false, code: "NO_DATABASE" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("sem CONSULTAS_CRIAR → FORBIDDEN (só visões compartilhadas, no C2)", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_CONSULTORES"));
    expect(await executarConsulta(spec, 1)).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("spec inválida → INVALID com mensagem amigável", async () => {
    const result = await executarConsulta({ entity: "consultores", sql: "SELECT 1" }, 1);
    expect(result).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("erro inesperado → FAILED genérico, sem detalhes do banco", async () => {
    transaction.mockRejectedValue(new Error('column "x" of relation "consulta_consultores"'));
    const result = await executarConsulta(spec, 1);
    expect(result).toMatchObject({ ok: false, code: "FAILED" });
    expect(JSON.stringify(result)).not.toContain("consulta_consultores");
  });

  it("escopo sem universo (ex.: PEOPLE sem RELATORIOS_CONSULTORES) roda com WHERE (FALSE)", async () => {
    resolveReportScope.mockResolvedValue({ broad: false, includeFinancials: false, financeHoursLimited: false });
    await executarConsulta(spec, 1);
    for (const [sql] of queryRaw.mock.calls as [{ text: string }][]) {
      expect(sql.text).toContain("WHERE (FALSE)");
    }
  });

  it("página fora da faixa é limitada a 1000 linhas navegáveis (página 10)", async () => {
    const result = await executarConsulta(spec, 999);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result).toMatchObject({ page: 10, pageCount: 10, totalRows: 5000, navigableRows: 1000 });
    const rows = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(rows.values.slice(-2)).toEqual([100, 900]);
  });

  it.each([["texto", "2"], ["NaN", Number.NaN], ["negativa", -5], ["Infinity", Infinity]])(
    "página %s cai na página 1",
    async (_label, page) => {
      const result = await executarConsulta(spec, page);
      expect(result.ok && result.result.page).toBe(1);
    },
  );

  it("link de detalhe usa o id codificado (sem path traversal)", async () => {
    const result = await executarConsulta(spec, 1);
    expect(result.ok && result.result.rows[0]._href).toBe(
      `/app/consultores/${encodeURIComponent("../admin?x=1")}`,
    );
  });

  it("resultado devolvido ao cliente não expõe aliases SQL", async () => {
    const result = await executarConsulta(spec, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const column of result.result.columns) expect(column).not.toHaveProperty("alias");
    expect(Object.keys(result.result.rows[0])).not.toContain("c0");
  });
});
