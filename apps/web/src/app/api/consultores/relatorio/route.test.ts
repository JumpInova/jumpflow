import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { ConsultantReportRow } from "@/lib/db/consultant-project-history";

/**
 * Contrato do export "Relatório de consultores": o gate é recomputado no
 * servidor (CONSULTANT_REPORT_ROLES ou Matriz), o filtro é validado por Zod e a
 * planilha traz o histórico de projetos sem nenhuma coluna financeira.
 */

let currentUser: AppUser;
let matrixGrant = false;
let rows: ConsultantReportRow[] = [];
const getReport = vi.fn(async () => rows);
const recordAuditEvent = vi.fn(async () => {});

vi.mock("@/lib/auth/guards", async () => {
  const { hasRole } = await import("@/lib/auth/route-permissions");
  return {
    requireUser: vi.fn(async () => currentUser),
    hasRoleOrPermission: vi.fn(
      async (user: AppUser, roles: Parameters<typeof hasRole>[1]) =>
        hasRole(user, roles) || matrixGrant,
    ),
  };
});
let databaseConfigured = true;
vi.mock("@/lib/db/config", () => ({
  isDatabaseConfigured: () => databaseConfigured,
}));
vi.mock("@/lib/db/consultant-project-history", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/db/consultant-project-history")
  >("@/lib/db/consultant-project-history");
  return {
    consultantReportFilterSchema: actual.consultantReportFilterSchema,
    getConsultantProjectReport: getReport,
  };
});
vi.mock("@/lib/db/users", () => ({ resolveDbUser: vi.fn(async () => ({ id: "u1" })) }));
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent }));

import { GET } from "./route";

function user(roles: AppUser["roles"]): AppUser {
  return { id: "x", name: "X", email: "x@jumplabel.com.br", roles };
}
function req(query = ""): Request {
  return new Request(`http://localhost/api/consultores/relatorio${query}`);
}

beforeEach(() => {
  matrixGrant = false;
  databaseConfigured = true;
  getReport.mockClear();
  recordAuditEvent.mockClear();
  rows = [
    {
      consultantName: "Ana",
      consultantEmail: "ana@jumplabel.com.br",
      jobTitle: "Dev",
      area: "Dados",
      seniority: "SENIOR",
      consultantStatus: "ACTIVE",
      project: {
        allocationId: "a1",
        projectId: "p1",
        projectName: "Atlas",
        clientName: "Vix",
        role: "Tech Lead",
        startDate: "2026-01-05",
        endDate: null,
        status: "ACTIVE",
      },
    },
    {
      consultantName: "Bia",
      consultantEmail: "bia@jumplabel.com.br",
      jobTitle: null,
      area: null,
      seniority: "JUNIOR",
      consultantStatus: "ACTIVE",
      project: null,
    },
  ];
});

describe("GET /api/consultores/relatorio", () => {
  it("refuses a consultant without the matrix grant", async () => {
    currentUser = user(["CONSULTANT"]);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(getReport).not.toHaveBeenCalled();
  });

  it("answers 503 without a database", async () => {
    currentUser = user(["AREA_MANAGER"]);
    databaseConfigured = false;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(getReport).not.toHaveBeenCalled();
  });

  it("allows a matrix-granted role", async () => {
    currentUser = user(["PROJECT_MANAGER"]);
    matrixGrant = true;
    const res = await GET(req());
    expect(res.status).toBe(200);
  });

  it("rejects an invalid filter", async () => {
    currentUser = user(["AREA_MANAGER"]);
    const res = await GET(req("?projectStatus=WHATEVER"));
    expect(res.status).toBe(400);
  });

  it("exports the project history for the area manager, ignoring empty selects", async () => {
    currentUser = user(["AREA_MANAGER"]);
    const res = await GET(req("?area=&consultantStatus=ACTIVE&projectStatus="));
    expect(res.status).toBe(200);
    expect(getReport).toHaveBeenCalledWith({ consultantStatus: "ACTIVE" });
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CONSULTANTS_REPORT_EXPORTED" }),
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual([
      "Consultor",
      "E-mail",
      "Cargo",
      "Área",
      "Senioridade",
      "Status do consultor",
      "Cliente",
      "Projeto",
      "Perfil no projeto",
      "Início",
      "Fim",
      "Status no projeto",
    ]);
    const ana = (ws.getRow(2).values as unknown[]).slice(1);
    expect(ana[7]).toBe("Atlas");
    expect(ana[8]).toBe("Tech Lead");
    expect((ana[9] as Date).toISOString().slice(0, 10)).toBe("2026-01-05");
    expect(ana[11]).toBe("Ativo");
    const bia = (ws.getRow(3).values as unknown[]).slice(1);
    expect(bia[0]).toBe("Bia");
    expect(bia[7] ?? "").toBe("");
  });
});
