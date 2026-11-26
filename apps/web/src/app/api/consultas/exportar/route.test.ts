import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

/**
 * Contrato da exportação de Consultas (Fase C1, testador): a rota usa o
 * caminho REAL `exportConsulta` (lib/db/consultas) com Prisma/matriz/escopo
 * mockados. Gate `CONSULTAS_EXPORTAR`, spec inválida/proibida, escopo de linha
 * no SQL, CSV com escape de fórmula, XLSX e auditoria.
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

let currentUser: AppUser;
let databaseConfigured = true;

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
import { POST } from "./route";

const ALL = ["CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR"];

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/consultas/exportar", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const spec = {
  entity: "horas",
  filters: {
    logic: "or",
    conditions: [
      { field: "consultor", op: "contains", value: "a" },
      { field: "horas", op: "gte", value: 0 },
    ],
  },
  columns: ["data", "consultor", "descricao", "horas"],
  groupBy: [],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [],
};

const decimal = (n: number) => ({ toNumber: () => n, toString: () => String(n) });

beforeEach(() => {
  currentUser = { id: "u1", name: "Gestora", email: "g@jump", roles: ["PROJECT_MANAGER"] } as AppUser;
  databaseConfigured = true;
  getCurrentMatrix.mockResolvedValue(grant(...ALL));
  resolveReportScope.mockResolvedValue({
    broad: false,
    managerUserId: "pm-db",
    includeFinancials: false,
    financeHoursLimited: false,
  });
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  );
  queryRaw.mockImplementation(async (sql: { text: string }) => {
    if (sql.text.includes('AS "total"')) return [{ total: 2 }];
    if (sql.text.startsWith("SELECT SUM")) return [{ m0: decimal(-1.5) }];
    return [
      { c0: new Date("2026-11-03T00:00:00Z"), c1: "=HYPERLINK(\"http://x\",\"y\")", c2: "@SUM(1+1)", c3: decimal(-1.5), _detail: "c-1" },
      { c0: new Date("2026-11-04T00:00:00Z"), c1: "Ana; \"Bia\"", c2: "+55 11 9999", c3: decimal(8), _detail: "c-2" },
    ];
  });
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/consultas/exportar — gates", () => {
  it("sem CONSULTAS_EXPORTAR → 403 sem tocar o banco nem auditar", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR"));
    const res = await POST(post({ format: "csv", spec }));
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("CONSULTAS_EXPORTAR sem CONSULTAS_CRIAR → 403 (construtor exige criar)", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"));
    const res = await POST(post({ format: "xlsx", spec }));
    expect(res.status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("sem view na entidade → 403", async () => {
    getCurrentMatrix.mockResolvedValue(grant("CONSULTAS", "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR", "CONSULTAS_ALOCACOES"));
    expect((await POST(post({ format: "csv", spec }))).status).toBe(403);
  });

  it("campo financeiro sem a regra financeira → 403 (não exporta mascarado)", async () => {
    const res = await POST(post({ format: "csv", spec: { ...spec, columns: ["data", "receita"] } }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toMatch(/SELECT|consulta_horas/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("matriz ilegível → falha fechada (403)", async () => {
    getCurrentMatrix.mockRejectedValue(new Error("db down"));
    expect((await POST(post({ format: "csv", spec }))).status).toBe(403);
    expect(transaction).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON quebrado", "{not json"],
    ["formato inventado", { format: "pdf", spec }],
    ["sem formato", { spec }],
    ["SQL em vez de spec", { format: "csv", spec: { sql: "SELECT * FROM \"User\"" } }],
    ["coluna injetada", { format: "csv", spec: { ...spec, columns: ['data" FROM "User" --'] } }],
  ])("%s → 400", async (_label, body) => {
    const res = await POST(post(body));
    expect(res.status).toBe(400);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("sem banco → 503", async () => {
    databaseConfigured = false;
    expect((await POST(post({ format: "csv", spec }))).status).toBe(503);
  });

  it("erro do banco vira 500 genérico, sem SQL nem detalhe", async () => {
    transaction.mockRejectedValue(new Error('relation "consulta_horas" does not exist at SELECT ...'));
    const res = await POST(post({ format: "csv", spec }));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/consulta_horas|SELECT|relation/);
  });

  it("timeout do Postgres → 504", async () => {
    transaction.mockRejectedValue(new Error("canceling statement due to statement timeout"));
    expect((await POST(post({ format: "csv", spec }))).status).toBe(504);
  });
});

describe("POST /api/consultas/exportar — conteúdo", () => {
  it("SQL roda com timeout e escopo de linha como 1º termo (OR do usuário entre parênteses)", async () => {
    await POST(post({ format: "csv", spec }));
    expect(executeRaw.mock.calls[0][0].text).toBe("SET LOCAL statement_timeout = '15s'");
    for (const [sql] of queryRaw.mock.calls as [{ text: string; values: unknown[] }][]) {
      expect(sql.text).toContain('WHERE ("project_manager_id" = $1) AND ((');
      expect(sql.values[0]).toBe("pm-db");
    }
    const rows = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(rows.values.slice(-2)).toEqual([50_000, 0]);
  });

  it("CSV: BOM, `;`, CRLF, escape de fórmula em texto e números negativos intactos", async () => {
    const res = await POST(post({ format: "csv", spec }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(res.headers.get("Content-Disposition")).toMatch(/consulta-horas_\d{4}-\d{2}-\d{2}\.csv/);
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe('"Data";"Consultor";"Descrição";"Horas lançadas"');
    expect(lines[1]).toBe(`"03/11/2026";"'=HYPERLINK(""http://x"",""y"")";"'@SUM(1+1)";"-1,5"`);
    expect(lines[2]).toBe(`"04/11/2026";"Ana; ""Bia""";"'+55 11 9999";"8"`);
    expect(lines[3]).toBe("");
  });

  it("XLSX: aba da entidade + aba Totais; fórmula maliciosa fica como texto", async () => {
    const res = await POST(post({ format: "xlsx", spec }));
    expect(res.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await res.arrayBuffer());
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe("Horas");
    const cell = sheet.getRow(2).getCell(2);
    expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(String(cell.value)).toContain("HYPERLINK");
    expect(sheet.getRow(2).getCell(4).value).toBe(-1.5);
    const totals = workbook.getWorksheet("Totais");
    expect(totals).toBeDefined();
    expect(totals!.getRow(2).getCell(2).value).toBe(-1.5);
  });

  it("toda exportação é auditada (formato, contagem, spec normalizada)", async () => {
    await POST(post({ format: "csv", spec }));
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "CONSULTA_EXPORTADA",
        entityType: "Consulta",
        entityId: "horas",
        actorUserId: "db-user",
        after: expect.objectContaining({
          format: "csv",
          rowCount: 2,
          totalRows: 2,
          usesSensitive: false,
          spec: expect.objectContaining({ entity: "horas" }),
        }),
      }),
    );
  });

  it("limit da spec reduz o teto de 50.000", async () => {
    await POST(post({ format: "csv", spec: { ...spec, limit: 10 } }));
    expect((queryRaw.mock.calls[0][0] as { values: unknown[] }).values.slice(-2)).toEqual([10, 0]);
  });
});
