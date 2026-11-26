import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

/**
 * Visões salvas e painéis (C2) no servidor, com Prisma/matriz mockados:
 * compartilhamento, execução com a permissão de QUEM VÊ, painel sem vazamento
 * de visão privada, exportação `saved_view` e auditoria.
 */

const {
  executeRaw,
  queryRaw,
  transaction,
  recordAuditEvent,
  getCurrentMatrix,
  resolveReportScope,
  resolveDbUser,
  viewFindMany,
  viewFindUnique,
  viewCreate,
  viewUpdate,
  viewDelete,
  panelFindMany,
  panelFindUnique,
  panelCreate,
  panelUpdate,
  panelDelete,
} = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
  transaction: vi.fn(),
  recordAuditEvent: vi.fn(async (input: unknown) => void input),
  getCurrentMatrix: vi.fn<() => Promise<PermissionMatrix>>(),
  resolveReportScope: vi.fn(),
  resolveDbUser: vi.fn(),
  viewFindMany: vi.fn(),
  viewFindUnique: vi.fn(),
  viewCreate: vi.fn(),
  viewUpdate: vi.fn(),
  viewDelete: vi.fn(),
  panelFindMany: vi.fn(),
  panelFindUnique: vi.fn(),
  panelCreate: vi.fn(),
  panelUpdate: vi.fn(),
  panelDelete: vi.fn(),
}));

vi.mock("@jumpflow/database", async () => {
  const actual = await vi.importActual<typeof import("@jumpflow/database")>("@jumpflow/database");
  return {
    Prisma: actual.Prisma,
    prisma: {
      $transaction: (...args: unknown[]) => transaction(...args),
      consultaView: {
        findMany: viewFindMany,
        findUnique: viewFindUnique,
        create: viewCreate,
        update: viewUpdate,
        delete: viewDelete,
      },
      consultaPanel: {
        findMany: panelFindMany,
        findUnique: panelFindUnique,
        create: panelCreate,
        update: panelUpdate,
        delete: panelDelete,
      },
    },
  };
});
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent }));
vi.mock("@/lib/auth/permissions", () => ({ getCurrentMatrix }));
vi.mock("@/lib/db/reports", () => ({ resolveReportScope }));
vi.mock("@/lib/auth/sensitive-data", () => ({ canAccessSensitiveCost: () => false }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser }));

import { aggregateRolePermissions } from "@/lib/auth/permission-codes";
import { ConsultaError } from "@/lib/consultas/errors";
import {
  createPanel,
  createSavedView,
  deleteSavedView,
  exportSavedView,
  getPanelForViewer,
  listSavedViews,
  runSavedView,
  updateSavedView,
} from "./consultas-saved";

const pmUser: AppUser = { id: "auth-pm", name: "Paula PM", email: "pm@jump", roles: ["PROJECT_MANAGER"] };
const finUser: AppUser = { id: "auth-fin", name: "Fábio Fin", email: "fin@jump", roles: ["FINANCE"] };
const adminUser: AppUser = { id: "auth-admin", name: "Ana Admin", email: "adm@jump", roles: ["ADMIN"] };

const DB_IDS: Record<string, string> = { "auth-pm": "db-pm", "auth-fin": "db-fin", "auth-admin": "db-admin" };

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const hoursSpec = {
  entity: "horas",
  filters: null,
  columns: ["data", "consultor", "horas"],
  groupBy: [],
  measures: [{ field: "horas", agg: "sum" }],
  sort: [],
};
const revenueSpec = { ...hoursSpec, columns: ["data", "receita"], measures: [] };

function viewRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "v1",
    ownerId: "db-fin",
    name: "Horas do time",
    description: null,
    entity: "horas",
    spec: hoursSpec,
    visualization: "TABLE",
    sharing: "PRIVATE",
    sharedRoles: [],
    updatedAt: new Date("2026-11-20T12:00:00Z"),
    owner: { name: "Fábio Fin" },
    ...over,
  };
}

let matrixByUser: Record<string, PermissionMatrix>;
let currentUser: AppUser;

function as(user: AppUser) {
  currentUser = user;
  return user;
}

beforeEach(() => {
  matrixByUser = {
    "auth-pm": grant("CONSULTAS", "CONSULTAS_HORAS"),
    "auth-fin": grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR", "CONSULTAS_COMPARTILHAR"),
    "auth-admin": grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR", "CONSULTAS_COMPARTILHAR"),
  };
  getCurrentMatrix.mockImplementation(async () => matrixByUser[currentUser.id]);
  resolveDbUser.mockImplementation(async (user: AppUser) => ({ id: DB_IDS[user.id], name: user.name, email: user.email }));
  resolveReportScope.mockImplementation(async (user: AppUser) =>
    user.roles.includes("PROJECT_MANAGER")
      ? { broad: false, managerUserId: "db-pm", includeFinancials: false, financeHoursLimited: false }
      : { broad: true, includeFinancials: true, financeHoursLimited: user.roles.includes("FINANCE") },
  );
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  );
  queryRaw.mockImplementation(async (sql: { text: string }) => {
    if (sql.text.includes('AS "total"')) return [{ total: 1 }];
    if (sql.text.startsWith("SELECT SUM")) return [{ m0: 8 }];
    return [{ c0: new Date("2026-11-03T00:00:00Z"), c1: "Ana", c2: 8, _detail: "c-1" }];
  });
  viewCreate.mockResolvedValue({ id: "new-view" });
  panelCreate.mockResolvedValue({ id: "new-panel" });
});

afterEach(() => vi.clearAllMocks());

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ConsultaError ? error.code : "OTHER";
  }
  return undefined;
}

function auditActions(): string[] {
  return recordAuditEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
}

describe("listagem de visões", () => {
  it("nunca lista visão privada de outro dono, mesmo que o banco a devolva", async () => {
    viewFindMany.mockResolvedValue([
      viewRow({ id: "priv", name: "Segredo do Financeiro" }),
      viewRow({ id: "all", name: "Para todos", sharing: "ALL" }),
      viewRow({ id: "roles-pm", name: "Para PMs", sharing: "ROLES", sharedRoles: ["PROJECT_MANAGER"] }),
      viewRow({ id: "roles-people", name: "Para People", sharing: "ROLES", sharedRoles: ["PEOPLE"] }),
    ]);
    const { mine, shared } = await listSavedViews(as(pmUser));
    expect(mine).toEqual([]);
    expect(shared.map((v) => v.id)).toEqual(["all", "roles-pm"]);
    expect(JSON.stringify(shared)).not.toContain("Segredo");
    // O filtro do banco já restringe por dono/ALL/papéis de quem vê.
    expect(viewFindMany.mock.calls[0][0].where).toEqual({
      OR: [
        { ownerId: "db-pm" },
        { sharing: "ALL" },
        { sharing: "ROLES", sharedRoles: { hasSome: ["PROJECT_MANAGER"] } },
      ],
    });
  });

  it("entidade sem acesso ou campo financeiro somem para quem vê; o dono vê a sua como indisponível", async () => {
    viewFindMany.mockResolvedValue([
      viewRow({ id: "desp", sharing: "ALL", entity: "despesas", spec: { ...hoursSpec, entity: "despesas" } }),
      viewRow({ id: "rev", sharing: "ALL", spec: revenueSpec }),
      viewRow({ id: "mine-rev", ownerId: "db-pm", spec: revenueSpec }),
    ]);
    const { mine, shared } = await listSavedViews(as(pmUser));
    expect(shared).toEqual([]);
    expect(mine.map((v) => [v.id, v.available])).toEqual([["mine-rev", false]]);
  });

  it("sem o módulo CONSULTAS, nada é lido", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS_HORAS");
    expect(await listSavedViews(as(pmUser))).toEqual({ mine: [], shared: [] });
    expect(viewFindMany).not.toHaveBeenCalled();
  });
});

describe("executar visão: spec do banco, permissão de quem vê", () => {
  it("visão compartilhada roda com o escopo do PM (sem CONSULTAS_CRIAR) e audita só se sensível", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    const result = await runSavedView(as(pmUser), "v1");
    expect(result.rows).toHaveLength(1);
    const sql = queryRaw.mock.calls[0][0] as { text: string; values: unknown[] };
    expect(sql.text).toContain('WHERE ("project_manager_id" = $1)');
    expect(sql.values[0]).toBe("db-pm");
    expect(auditActions()).toEqual([]);
  });

  it("visão privada de outro dono → NOT_FOUND (nem ADMIN abre)", async () => {
    viewFindUnique.mockResolvedValue(viewRow());
    expect(await codeOf(runSavedView(as(pmUser), "v1"))).toBe("NOT_FOUND");
    expect(await codeOf(runSavedView(as(adminUser), "v1"))).toBe("NOT_FOUND");
    viewFindUnique.mockResolvedValue(null);
    expect(await codeOf(runSavedView(as(pmUser), "nao-existe"))).toBe("NOT_FOUND");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("dono com spec que ficou indisponível → FORBIDDEN sem executar", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm", spec: revenueSpec }));
    expect(await codeOf(runSavedView(as(pmUser), "v1"))).toBe("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
  });

  it("execução com campo financeiro é auditada com origem saved_view e viewId", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ spec: revenueSpec }));
    await runSavedView(as(finUser), "v1");
    const call = recordAuditEvent.mock.calls[0][0] as { action: string; after: Record<string, unknown> };
    expect(call.action).toBe("CONSULTA_EXECUTADA_SENSIVEL");
    expect(call.after).toMatchObject({ origin: "saved_view", viewId: "v1" });
  });
});

describe("exportar visão salva", () => {
  it("exige CONSULTAS_EXPORTAR; não exige CRIAR; audita com origem saved_view", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    expect(await codeOf(exportSavedView(as(pmUser), "v1", "csv"))).toBe("FORBIDDEN");

    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR");
    const data = await exportSavedView(as(pmUser), "v1", "xlsx");
    expect(data.viewName).toBe("Horas do time");
    const call = recordAuditEvent.mock.calls.at(-1)![0] as { action: string; after: Record<string, unknown> };
    expect(call.action).toBe("CONSULTA_EXPORTADA");
    expect(call.after).toMatchObject({ origin: "saved_view", viewId: "v1", format: "xlsx" });
    const sql = queryRaw.mock.calls[0][0] as { values: unknown[] };
    expect(sql.values[0]).toBe("db-pm");
  });
});

describe("criar, alterar e excluir visão", () => {
  const form = { name: "Minha visão", visualization: "BAR", sharing: "PRIVATE", sharedRoles: [] };

  it("sem CONSULTAS_CRIAR → FORBIDDEN", async () => {
    expect(await codeOf(createSavedView(as(pmUser), { spec: hoursSpec, ...form }))).toBe("FORBIDDEN");
    expect(viewCreate).not.toHaveBeenCalled();
  });

  it("compartilhar sem CONSULTAS_COMPARTILHAR → FORBIDDEN; spec com campo proibido → FORBIDDEN", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR");
    expect(await codeOf(createSavedView(as(pmUser), { spec: hoursSpec, ...form, sharing: "ALL" }))).toBe("FORBIDDEN");
    expect(await codeOf(createSavedView(as(pmUser), { spec: revenueSpec, ...form }))).toBe("FORBIDDEN");
    expect(await codeOf(createSavedView(as(pmUser), { spec: { entity: "horas", sql: "x" }, ...form }))).toBe("INVALID");
    expect(viewCreate).not.toHaveBeenCalled();
  });

  it("grava spec normalizada com o dono do banco e audita criação + compartilhamento", async () => {
    const id = await createSavedView(as(finUser), {
      spec: { ...hoursSpec, columns: [] },
      ...form,
      sharing: "ROLES",
      sharedRoles: ["PEOPLE"],
    });
    expect(id).toBe("new-view");
    const data = viewCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({ ownerId: "db-fin", entity: "horas", sharing: "ROLES", sharedRoles: ["PEOPLE"] });
    expect(data.spec.columns.length).toBeGreaterThan(0);
    expect(auditActions()).toEqual(["CONSULTA_VISAO_CRIADA", "CONSULTA_VISAO_COMPARTILHADA"]);
  });

  it("só o dono altera/exclui — ADMIN recebe NOT_FOUND", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    expect(await codeOf(updateSavedView(as(adminUser), "v1", form))).toBe("NOT_FOUND");
    expect(await codeOf(deleteSavedView(as(adminUser), "v1"))).toBe("NOT_FOUND");
    expect(viewUpdate).not.toHaveBeenCalled();
    expect(viewDelete).not.toHaveBeenCalled();
  });

  it("dono sem COMPARTILHAR pode tornar privada, mas não compartilhar", async () => {
    matrixByUser["auth-fin"] = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR");
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await updateSavedView(as(finUser), "v1", form);
    expect(auditActions()).toEqual(["CONSULTA_VISAO_ATUALIZADA", "CONSULTA_VISAO_COMPARTILHADA"]);
    viewFindUnique.mockResolvedValue(viewRow());
    expect(await codeOf(updateSavedView(as(finUser), "v1", { ...form, sharing: "ALL" }))).toBe("FORBIDDEN");
  });

  it("excluir audita o estado anterior", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await deleteSavedView(as(finUser), "v1");
    expect(viewDelete).toHaveBeenCalledWith({ where: { id: "v1" } });
    const call = recordAuditEvent.mock.calls[0][0] as { action: string; before: Record<string, unknown> };
    expect(call.action).toBe("CONSULTA_VISAO_EXCLUIDA");
    expect(call.before).toMatchObject({ name: "Horas do time", sharing: "ALL" });
  });
});

describe("painéis: revalidação por visão para quem vê", () => {
  const panelRow = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "p1",
    ownerId: "db-fin",
    name: "Painel do Financeiro",
    description: null,
    items: [{ viewId: "ok" }, { viewId: "priv" }, { viewId: "desp" }, { viewId: "rev" }, { viewId: "sumiu" }],
    sharing: "ALL",
    sharedRoles: [],
    updatedAt: new Date("2026-11-20T12:00:00Z"),
    owner: { name: "Fábio Fin" },
    ...over,
  });

  it("visões privadas/inacessíveis não aparecem nem com nome — só a contagem", async () => {
    panelFindUnique.mockResolvedValue(panelRow());
    viewFindMany.mockResolvedValue([
      viewRow({ id: "ok", name: "Visão aberta", sharing: "ALL" }),
      viewRow({ id: "priv", name: "Margem secreta" }),
      viewRow({ id: "desp", name: "Despesas do CEO", sharing: "ALL", entity: "despesas", spec: { ...hoursSpec, entity: "despesas" } }),
      viewRow({ id: "rev", name: "Receita por cliente", sharing: "ALL", spec: revenueSpec }),
    ]);
    const panel = await getPanelForViewer(as(pmUser), "p1");
    expect(panel!.items.map((item) => item.viewId)).toEqual(["ok"]);
    expect(panel!.hiddenCount).toBe(4);
    expect(panel!.ownerItems).toBeUndefined();
    const json = JSON.stringify(panel);
    for (const secret of ["Margem secreta", "Despesas do CEO", "Receita por cliente", "priv", "desp", "sumiu"]) {
      expect(json).not.toContain(secret);
    }
  });

  it("painel privado de outro dono → null (nem ADMIN)", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ sharing: "PRIVATE" }));
    expect(await getPanelForViewer(as(adminUser), "p1")).toBeNull();
    expect(viewFindMany).not.toHaveBeenCalled();
  });

  it("criar painel com visão que o criador não abre → INVALID; mais de 24 → INVALID", async () => {
    viewFindMany.mockResolvedValue([viewRow({ id: "alheia", ownerId: "db-pm" })]);
    expect(
      await codeOf(createPanel(as(finUser), { name: "P", items: [{ viewId: "alheia" }], sharing: "PRIVATE" })),
    ).toBe("INVALID");
    const many = Array.from({ length: 25 }, (_, i) => ({ viewId: `v${i}` }));
    expect(await codeOf(createPanel(as(finUser), { name: "P", items: many, sharing: "PRIVATE" }))).toBe("INVALID");
    expect(panelCreate).not.toHaveBeenCalled();
  });

  it("criar painel válido grava e audita criação e compartilhamento", async () => {
    viewFindMany.mockResolvedValue([viewRow({ id: "v1" })]);
    const id = await createPanel(as(finUser), {
      name: "Painel",
      items: [{ viewId: "v1", size: "largo" }],
      sharing: "ALL",
    });
    expect(id).toBe("new-panel");
    expect(panelCreate.mock.calls[0][0].data).toMatchObject({ ownerId: "db-fin", items: [{ viewId: "v1", size: "largo" }] });
    expect(auditActions()).toEqual(["CONSULTA_PAINEL_CRIADO", "CONSULTA_PAINEL_COMPARTILHADO"]);
  });
});
