import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/lib/auth/types";
import type { PermissionMatrix } from "@/lib/auth/permission-codes";

/**
 * Fase C2 (testador): segurança de visões salvas e painéis no servidor, com
 * Prisma/matriz mockados. Foco: 404 indistinguível, permissão e escopo de
 * QUEM VÊ, spec nunca do cliente, painéis sem vazamento, auditoria.
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
  deletePanel,
  deleteSavedView,
  exportSavedView,
  getPanelForViewer,
  getSavedViewForViewer,
  listPanels,
  listSavedViews,
  runSavedView,
  updatePanel,
  updateSavedView,
} from "./consultas-saved";

const pmUser: AppUser = { id: "auth-pm", name: "Paula PM", email: "pm@jump", roles: ["PROJECT_MANAGER"] };
const finUser: AppUser = { id: "auth-fin", name: "Fábio Fin", email: "fin@jump", roles: ["FINANCE"] };
const adminUser: AppUser = { id: "auth-admin", name: "Ana Admin", email: "adm@jump", roles: ["ADMIN"] };
const peopleUser: AppUser = { id: "auth-people", name: "Pri People", email: "people@jump", roles: ["PEOPLE"] };

const DB_IDS: Record<string, string> = {
  "auth-pm": "db-pm",
  "auth-fin": "db-fin",
  "auth-admin": "db-admin",
  "auth-people": "db-people",
};

const ALL_ENTITIES = [
  "CONSULTAS_HORAS",
  "CONSULTAS_ALOCACOES",
  "CONSULTAS_CONSULTORES",
  "CONSULTAS_PROJETOS",
  "CONSULTAS_APROVACOES",
  "CONSULTAS_DESPESAS",
  "CONSULTAS_FATURAMENTO",
  "CONSULTAS_PAGAMENTOS",
  "CONSULTAS_SKILLS",
  "CONSULTAS_AUSENCIAS",
];

function grant(...codes: string[]): PermissionMatrix {
  return aggregateRolePermissions(
    codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
  );
}

const projectsSpec = {
  entity: "projetos",
  filters: null,
  columns: ["projeto", "status"],
  groupBy: [],
  measures: [],
  sort: [],
};
/** Visão "do Financeiro": usa campo financeiro (valor-hora padrão) — o PM não pode. */
const projectsFinanceSpec = { ...projectsSpec, columns: ["projeto", "valor_hora_padrao"] };
/** Campo financeiro só no FILTRO (não aparece em colunas). */
const projectsFinanceFilterSpec = {
  ...projectsSpec,
  filters: { logic: "or", conditions: [{ field: "horas_orcadas", op: "gt", value: 0 }, { field: "projeto", op: "not_null" }] },
};
const paymentsSpec = {
  entity: "pagamentos",
  filters: null,
  columns: ["competencia", "consultor", "status"],
  groupBy: [],
  measures: [],
  sort: [],
};

function viewRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "v1",
    ownerId: "db-fin",
    name: "Projetos do Financeiro",
    description: "Descrição interna",
    entity: "projetos",
    spec: projectsSpec,
    visualization: "TABLE",
    sharing: "PRIVATE",
    sharedRoles: [],
    updatedAt: new Date("2026-11-20T12:00:00Z"),
    owner: { name: "Fábio Fin" },
    ...over,
  };
}

function panelRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "p1",
    ownerId: "db-fin",
    name: "Painel",
    description: null,
    items: [{ viewId: "v1" }],
    sharing: "ALL",
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
    // PM: só ver e exportar (sem CRIAR, sem COMPARTILHAR).
    "auth-pm": grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_HORAS", "CONSULTAS_EXPORTAR"),
    "auth-fin": grant("CONSULTAS", ...ALL_ENTITIES, "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR", "CONSULTAS_COMPARTILHAR"),
    "auth-admin": grant("CONSULTAS", ...ALL_ENTITIES, "CONSULTAS_CRIAR", "CONSULTAS_EXPORTAR", "CONSULTAS_COMPARTILHAR"),
    "auth-people": grant("CONSULTAS", "CONSULTAS_SKILLS", "CONSULTAS_CRIAR"),
  };
  getCurrentMatrix.mockImplementation(async () => matrixByUser[currentUser.id]);
  resolveDbUser.mockImplementation(async (user: AppUser) => ({ id: DB_IDS[user.id], name: user.name, email: user.email }));
  resolveReportScope.mockImplementation(async (user: AppUser) =>
    user.roles.includes("PROJECT_MANAGER")
      ? { broad: false, managerUserId: "db-pm", includeFinancials: false, financeHoursLimited: false }
      : {
          broad: true,
          includeFinancials: user.roles.includes("FINANCE") || user.roles.includes("ADMIN"),
          financeHoursLimited: false,
        },
  );
  transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
    work({ $executeRaw: executeRaw, $queryRaw: queryRaw }),
  );
  queryRaw.mockImplementation(async (sql: { text: string }) => {
    if (sql.text.includes('AS "total"')) return [{ total: 1 }];
    return [{ c0: "Atlas", c1: "ACTIVE", _detail: "p-1" }];
  });
  viewCreate.mockResolvedValue({ id: "new-view" });
  panelCreate.mockResolvedValue({ id: "new-panel" });
  panelFindMany.mockResolvedValue([]);
  viewFindMany.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; message: string } | undefined> {
  try {
    await promise;
  } catch (error) {
    return error instanceof ConsultaError
      ? { code: error.code, message: error.message }
      : { code: "OTHER", message: String(error) };
  }
  return undefined;
}

function auditActions(): string[] {
  return recordAuditEvent.mock.calls.map((call) => (call[0] as { action: string }).action);
}

function firstSql(): { text: string; values: unknown[] } {
  return queryRaw.mock.calls[0][0] as { text: string; values: unknown[] };
}

describe("visão: 404 indistinguível entre 'não existe' e 'sem acesso'", () => {
  it.each([
    ["privada de outro dono", viewRow()],
    ["ROLES para outro papel", viewRow({ sharing: "ROLES", sharedRoles: ["PEOPLE"] })],
    ["ALL com campo financeiro", viewRow({ sharing: "ALL", spec: projectsFinanceSpec })],
    ["ALL com campo financeiro só no filtro", viewRow({ sharing: "ALL", spec: projectsFinanceFilterSpec })],
    ["ALL de entidade sem acesso", viewRow({ sharing: "ALL", entity: "despesas", spec: { ...projectsSpec, entity: "despesas", columns: ["data"] } })],
    ["ALL com spec adulterada no banco", viewRow({ sharing: "ALL", spec: { entity: "projetos", sql: "SELECT * FROM \"User\"" } })],
  ])("PM: %s → mesmo código e mensagem de inexistente, sem executar", async (_label, row) => {
    viewFindUnique.mockResolvedValue(null);
    const missingRun = await errorOf(runSavedView(as(pmUser), "nao-existe"));
    const missingExport = await errorOf(exportSavedView(as(pmUser), "nao-existe", "csv"));

    viewFindUnique.mockResolvedValue(row);
    const run = await errorOf(runSavedView(as(pmUser), "v1"));
    const exported = await errorOf(exportSavedView(as(pmUser), "v1", "csv"));
    expect(run).toEqual(missingRun);
    expect(exported).toEqual(missingExport);
    expect(run!.code).toBe("NOT_FOUND");
    expect(run!.message).not.toContain((row as { name: string }).name);
    expect(await getSavedViewForViewer(as(pmUser), "v1")).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("nem ADMIN (com todas as entidades e finanças) abre, exporta, altera ou exclui visão privada alheia", async () => {
    viewFindUnique.mockResolvedValue(viewRow());
    const form = { name: "Hack", visualization: "TABLE", sharing: "ALL" };
    for (const promise of [
      runSavedView(as(adminUser), "v1"),
      exportSavedView(as(adminUser), "v1", "xlsx"),
      updateSavedView(as(adminUser), "v1", form),
      deleteSavedView(as(adminUser), "v1"),
    ]) {
      expect((await errorOf(promise))?.code).toBe("NOT_FOUND");
    }
    expect(await getSavedViewForViewer(as(adminUser), "v1")).toBeNull();
    expect(transaction).not.toHaveBeenCalled();
    expect(viewUpdate).not.toHaveBeenCalled();
    expect(viewDelete).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("não-dono alterando visão ALL recebe NOT_FOUND (não FORBIDDEN de compartilhamento)", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    const result = await errorOf(
      updateSavedView(as(pmUser), "v1", { name: "x", visualization: "TABLE", sharing: "PRIVATE" }),
    );
    expect(result?.code).toBe("NOT_FOUND");
    expect((await errorOf(deleteSavedView(as(peopleUser), "v1")))?.code).toBe("NOT_FOUND");
  });

  it("usuário sem registro no banco (userId nulo) nunca é tratado como dono", async () => {
    resolveDbUser.mockRejectedValue(new Error("sem usuário"));
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm" }));
    expect((await errorOf(runSavedView(as(pmUser), "v1")))?.code).toBe("NOT_FOUND");
    viewFindMany.mockResolvedValue([]);
    await listSavedViews(as(pmUser));
    expect(viewFindMany.mock.calls[0][0].where.OR).not.toContainEqual(expect.objectContaining({ ownerId: expect.anything() }));
  });
});

describe("visão: ROLES / ALL", () => {
  it("ROLES abre só para os papéis listados", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ROLES", sharedRoles: ["PROJECT_MANAGER"] }));
    await runSavedView(as(pmUser), "v1");
    expect(transaction).toHaveBeenCalledTimes(1);
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ROLES", sharedRoles: ["PROJECT_MANAGER"], entity: "skills", spec: { entity: "skills", filters: null, columns: ["skill"], groupBy: [], measures: [], sort: [] } }));
    expect((await errorOf(runSavedView(as(peopleUser), "v1")))?.code).toBe("NOT_FOUND");
  });

  it("ALL abre para qualquer um com módulo + entidade; sem o módulo, NOT_FOUND", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await runSavedView(as(pmUser), "v1");
    expect(transaction).toHaveBeenCalledTimes(1);
    matrixByUser["auth-pm"] = grant("CONSULTAS_PROJETOS", "CONSULTAS_EXPORTAR");
    expect((await errorOf(runSavedView(as(pmUser), "v1")))?.code).toBe("NOT_FOUND");
  });

  it("listagem: ROLES de outro papel e PRIVATE alheia não aparecem nem pelo nome", async () => {
    viewFindMany.mockResolvedValue([
      viewRow({ id: "a", name: "Para People", sharing: "ROLES", sharedRoles: ["PEOPLE"] }),
      viewRow({ id: "b", name: "Privada do Fin" }),
      viewRow({ id: "c", name: "Receita do Fin", sharing: "ALL", spec: projectsFinanceSpec }),
      viewRow({ id: "d", name: "Aberta", sharing: "ALL" }),
    ]);
    const lists = await listSavedViews(as(pmUser));
    expect(lists.shared.map((v) => v.id)).toEqual(["d"]);
    const json = JSON.stringify(lists);
    for (const secret of ["Para People", "Privada do Fin", "Receita do Fin"]) expect(json).not.toContain(secret);
    // O resumo nunca carrega a spec.
    expect(json).not.toContain("valor_hora_padrao");
  });
});

describe("visão: roda com permissão e escopo de QUEM VÊ", () => {
  it("visão do Financeiro (ALL, sem campo financeiro) aberta pelo PM aplica o escopo de linha do PM", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await runSavedView(as(pmUser), "v1");
    const sql = firstSql();
    expect(sql.text).toContain('FROM "consulta_projetos" WHERE ("project_manager_id" = $1)');
    expect(sql.values[0]).toBe("db-pm");
  });

  it("a mesma visão aberta pelo dono (Financeiro) roda com escopo amplo", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await runSavedView(as(finUser), "v1");
    expect(firstSql().text).toContain('FROM "consulta_projetos" WHERE (TRUE)');
  });

  it("visão de Pagamentos compartilhada com PM que tem o code na Matriz: escopo amplo-only → FALSE", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PAGAMENTOS");
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL", entity: "pagamentos", spec: paymentsSpec }));
    await runSavedView(as(pmUser), "v1");
    expect(firstSql().text).toContain('FROM "consulta_pagamentos" WHERE (FALSE)');
  });

  it("export: mesma regra — escopo do PM e spec do banco; filtro OU não escapa", async () => {
    viewFindUnique.mockResolvedValue(
      viewRow({
        sharing: "ALL",
        spec: { ...projectsSpec, filters: { logic: "or", conditions: [{ field: "projeto", op: "not_null" }, { field: "status", op: "is_null" }] } },
      }),
    );
    await exportSavedView(as(pmUser), "v1", "csv");
    const sql = firstSql();
    expect(sql.text).toMatch(/WHERE \("project_manager_id" = \$1\) AND \(\(.+\) OR \(.+\)\)/);
  });

  it("dono que perdeu o campo vê FORBIDDEN (não executa); dono que perdeu a entidade recebe NOT_FOUND", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm", spec: projectsFinanceSpec }));
    expect((await errorOf(runSavedView(as(pmUser), "v1")))?.code).toBe("FORBIDDEN");
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm", entity: "despesas", spec: { ...projectsSpec, entity: "despesas" } }));
    expect((await errorOf(runSavedView(as(pmUser), "v1")))?.code).toBe("NOT_FOUND");
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("export de visão salva", () => {
  it("sem EXPORTAR: FORBIDDEN, sem consulta e sem auditoria (mesmo com CRIAR)", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR");
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    expect((await errorOf(exportSavedView(as(pmUser), "v1", "xlsx")))?.code).toBe("FORBIDDEN");
    expect(transaction).not.toHaveBeenCalled();
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  it("com EXPORTAR e sem CRIAR: exporta e audita CONSULTA_EXPORTADA com origin saved_view e viewId", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ id: "v-xyz", sharing: "ALL" }));
    await exportSavedView(as(pmUser), "v-xyz", "csv");
    expect(auditActions()).toEqual(["CONSULTA_EXPORTADA"]);
    const call = recordAuditEvent.mock.calls[0][0] as { actorUserId: string; after: Record<string, unknown> };
    expect(call.actorUserId).toBe("db-pm");
    expect(call.after).toMatchObject({ origin: "saved_view", viewId: "v-xyz", format: "csv" });
  });

  it("o viewId auditado é o do banco (row.id), não um id arbitrário", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ id: "real-id", sharing: "ALL" }));
    await exportSavedView(as(pmUser), "real-id", "xlsx");
    expect((recordAuditEvent.mock.calls[0][0] as { after: Record<string, unknown> }).after.viewId).toBe("real-id");
  });
});

describe("criar/alterar visão: entrada do cliente", () => {
  const form = { name: "V", visualization: "TABLE", sharing: "PRIVATE", sharedRoles: [] };

  it("entidade gravada sai da spec validada; ownerId do cliente é ignorado", async () => {
    await createSavedView(as(finUser), {
      spec: projectsSpec,
      ...form,
      ...({ entity: "pagamentos", ownerId: "db-admin" } as Record<string, unknown>),
    });
    const data = viewCreate.mock.calls[0][0].data;
    expect(data.entity).toBe("projetos");
    expect(data.ownerId).toBe("db-fin");
  });

  it("PEOPLE com CRIAR mas sem COMPARTILHAR: ROLES e ALL recusados, PRIVATE aceito", async () => {
    const skills = { entity: "skills", filters: null, columns: ["skill"], groupBy: [], measures: [], sort: [] };
    for (const sharing of ["ROLES", "ALL"]) {
      const result = await errorOf(
        createSavedView(as(peopleUser), { spec: skills, ...form, sharing, sharedRoles: ["PEOPLE"] }),
      );
      expect(result?.code, sharing).toBe("FORBIDDEN");
    }
    expect(viewCreate).not.toHaveBeenCalled();
    await createSavedView(as(peopleUser), { spec: skills, ...form });
    expect(viewCreate).toHaveBeenCalledTimes(1);
  });

  it("papel inexistente em sharedRoles → INVALID", async () => {
    const result = await errorOf(
      createSavedView(as(finUser), { spec: projectsSpec, ...form, sharing: "ROLES", sharedRoles: ["ROOT"] }),
    );
    expect(result?.code).toBe("INVALID");
  });

  it("injeção na spec ao criar → INVALID/FORBIDDEN, nada gravado", async () => {
    for (const spec of [
      { ...projectsSpec, columns: ['projeto"; DROP TABLE "User"; --'] },
      { ...projectsSpec, entity: "consulta_projetos" },
      { ...projectsSpec, filters: { logic: "and", conditions: [{ field: "projeto", op: "raw", value: "1=1" }] } },
      { ...projectsSpec, sort: [{ key: "projeto; DROP", dir: "asc" }] },
    ]) {
      expect(["INVALID", "FORBIDDEN"]).toContain((await errorOf(createSavedView(as(finUser), { spec, ...form })))?.code);
    }
    expect(viewCreate).not.toHaveBeenCalled();
  });

  it("dono sem CRIAR altera nome/compartilhamento, mas não a spec", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PROJETOS");
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm" }));
    expect(
      (await errorOf(updateSavedView(as(pmUser), "v1", { ...form, spec: projectsSpec })))?.code,
    ).toBe("FORBIDDEN");
    expect(viewUpdate).not.toHaveBeenCalled();
    await updateSavedView(as(pmUser), "v1", { ...form, name: "Novo nome" });
    expect(viewUpdate.mock.calls[0][0].data).not.toHaveProperty("spec");
    expect(viewUpdate.mock.calls[0][0].data).not.toHaveProperty("ownerId");
  });

  it("dono não troca a spec por uma com campo que não pode ver", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR");
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm" }));
    expect(
      (await errorOf(updateSavedView(as(pmUser), "v1", { ...form, spec: projectsFinanceSpec })))?.code,
    ).toBe("FORBIDDEN");
    expect(viewUpdate).not.toHaveBeenCalled();
  });

  it("mudar ALL → ROLES audita o antes e o depois do compartilhamento", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ALL" }));
    await updateSavedView(as(finUser), "v1", { ...form, sharing: "ROLES", sharedRoles: ["PEOPLE"] });
    const shared = recordAuditEvent.mock.calls
      .map((call) => call[0] as { action: string; entityType: string; entityId: string; before: unknown; after: unknown })
      .find((call) => call.action === "CONSULTA_VISAO_COMPARTILHADA")!;
    expect(shared).toMatchObject({
      entityType: "ConsultaView",
      entityId: "v1",
      before: { sharing: "ALL", sharedRoles: [] },
      after: { sharing: "ROLES", sharedRoles: ["PEOPLE"] },
    });
  });

  it("sem mudar compartilhamento, não registra COMPARTILHADA nem exige COMPARTILHAR", async () => {
    matrixByUser["auth-fin"] = grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR");
    viewFindUnique.mockResolvedValue(viewRow({ sharing: "ROLES", sharedRoles: ["PEOPLE", "ADMIN"] }));
    await updateSavedView(as(finUser), "v1", { ...form, sharing: "ROLES", sharedRoles: ["ADMIN", "PEOPLE"] });
    expect(auditActions()).toEqual(["CONSULTA_VISAO_ATUALIZADA"]);
  });
});

describe("painéis: sem vazamento e revalidação por visão", () => {
  it("painel ROLES para outro papel → null, sem ler visões", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ sharing: "ROLES", sharedRoles: ["PEOPLE"] }));
    expect(await getPanelForViewer(as(pmUser), "p1")).toBeNull();
    expect(viewFindMany).not.toHaveBeenCalled();
  });

  it("sem o módulo CONSULTAS → null, sem ler o painel", async () => {
    matrixByUser["auth-pm"] = grant("CONSULTAS_PROJETOS");
    expect(await getPanelForViewer(as(pmUser), "p1")).toBeNull();
    expect(panelFindUnique).not.toHaveBeenCalled();
  });

  it("listagem de painéis: privado alheio não aparece mesmo que o banco devolva", async () => {
    panelFindMany.mockResolvedValue([
      panelRow({ id: "x", name: "Painel secreto", sharing: "PRIVATE" }),
      panelRow({ id: "y", name: "Painel People", sharing: "ROLES", sharedRoles: ["PEOPLE"] }),
      panelRow({ id: "z", name: "Painel geral" }),
    ]);
    const lists = await listPanels(as(pmUser));
    expect(lists.shared.map((p) => p.id)).toEqual(["z"]);
    expect(JSON.stringify(lists)).not.toMatch(/Painel secreto|Painel People/);
  });

  it("mesma visão: visível ao Financeiro, oculta ao PM (campo financeiro) — revalidação por quem vê", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ items: [{ viewId: "fin" }, { viewId: "pub" }] }));
    viewFindMany.mockResolvedValue([
      viewRow({ id: "fin", name: "Valor-hora por projeto", sharing: "ALL", spec: projectsFinanceSpec }),
      viewRow({ id: "pub", name: "Projetos ativos", sharing: "ALL" }),
    ]);
    const forFin = await getPanelForViewer(as(finUser), "p1");
    expect(forFin!.items.map((i) => i.viewId)).toEqual(["fin", "pub"]);
    expect(forFin!.hiddenCount).toBe(0);

    const forPm = await getPanelForViewer(as(pmUser), "p1");
    expect(forPm!.items.map((i) => i.viewId)).toEqual(["pub"]);
    expect(forPm!.hiddenCount).toBe(1);
    expect(forPm!.ownerItems).toBeUndefined();
    expect(JSON.stringify(forPm)).not.toMatch(/Valor-hora por projeto|"fin"/);
  });

  it("a própria visão do dono que ficou indisponível também não entra no painel (só na contagem)", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ ownerId: "db-pm", items: [{ viewId: "mine" }] }));
    viewFindMany.mockResolvedValue([viewRow({ id: "mine", ownerId: "db-pm", spec: projectsFinanceSpec })]);
    const panel = await getPanelForViewer(as(pmUser), "p1");
    expect(panel!.items).toEqual([]);
    expect(panel!.hiddenCount).toBe(1);
  });

  it("JSON do painel com mais de 24 itens: só 24 são consultados", async () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ viewId: `v${i}` }));
    panelFindUnique.mockResolvedValue(panelRow({ items }));
    await getPanelForViewer(as(pmUser), "p1");
    expect(viewFindMany.mock.calls[0][0].where.id.in).toHaveLength(24);
  });

  it("criar painel exige CRIAR; compartilhar exige COMPARTILHAR", async () => {
    viewFindMany.mockResolvedValue([viewRow({ id: "v1", ownerId: "db-pm" })]);
    expect((await errorOf(createPanel(as(pmUser), { name: "P", items: [{ viewId: "v1" }], sharing: "PRIVATE" })))?.code).toBe("FORBIDDEN");
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR");
    expect((await errorOf(createPanel(as(pmUser), { name: "P", items: [{ viewId: "v1" }], sharing: "ALL" })))?.code).toBe("FORBIDDEN");
    expect(panelCreate).not.toHaveBeenCalled();
    await createPanel(as(pmUser), { name: "P", items: [{ viewId: "v1" }], sharing: "PRIVATE" });
    expect(panelCreate).toHaveBeenCalledTimes(1);
  });

  it("criar painel com exatamente 24 visões abertas é aceito", async () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ viewId: `v${i}` }));
    viewFindMany.mockResolvedValue(items.map((item) => viewRow({ id: item.viewId })));
    expect(await createPanel(as(finUser), { name: "Cheio", items, sharing: "PRIVATE" })).toBe("new-panel");
  });

  it("criar painel citando visão privada alheia (por id adivinhado) → INVALID, mensagem sem o nome", async () => {
    viewFindMany.mockResolvedValue([viewRow({ id: "alheia", ownerId: "db-admin", name: "Plano secreto" })]);
    const result = await errorOf(
      createPanel(as(finUser), { name: "P", items: [{ viewId: "alheia" }], sharing: "PRIVATE" }),
    );
    expect(result?.code).toBe("INVALID");
    expect(result?.message).not.toContain("Plano secreto");
    expect(result?.message).not.toContain("alheia");
  });

  it("alterar painel: não-dono → NOT_FOUND; item NOVO inacessível → INVALID; item já gravado é preservado", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ items: [{ viewId: "antiga" }] }));
    expect(
      (await errorOf(updatePanel(as(adminUser), "p1", { name: "P", items: [{ viewId: "antiga" }], sharing: "ALL" })))?.code,
    ).toBe("NOT_FOUND");
    expect((await errorOf(deletePanel(as(adminUser), "p1")))?.code).toBe("NOT_FOUND");

    // Correção C2: o cliente só conhece (e só pode enviar) visões que o dono
    // abre hoje; "antiga" (inacessível) reenviada pelo cliente → INVALID.
    viewFindMany.mockResolvedValue([viewRow({ id: "nova", sharing: "ALL" })]);
    expect(
      (await errorOf(
        updatePanel(as(finUser), "p1", { name: "P", items: [{ viewId: "antiga" }, { viewId: "nova" }], sharing: "ALL" }),
      ))?.code,
    ).toBe("INVALID");
    expect(panelUpdate).not.toHaveBeenCalled();

    // Item já gravado e indisponível: mantido no fim por padrão, sem o cliente vê-lo.
    await updatePanel(as(finUser), "p1", { name: "P2", items: [{ viewId: "nova" }], sharing: "ALL" });
    expect(panelUpdate.mock.calls[0][0].data.items).toEqual([
      { viewId: "nova", size: "normal" },
      { viewId: "antiga", size: "normal" },
    ]);
    expect(auditActions()).toEqual(["CONSULTA_PAINEL_ATUALIZADO"]);

    // ...ou removido em bloco.
    await updatePanel(as(finUser), "p1", { name: "P2", items: [{ viewId: "nova" }], sharing: "ALL", keepUnavailable: false });
    expect(panelUpdate.mock.calls[1][0].data.items).toEqual([{ viewId: "nova", size: "normal" }]);
    const audit = recordAuditEvent.mock.calls.at(-1)![0] as { after: Record<string, unknown> };
    expect(audit.after).toMatchObject({ unavailableKept: 0, unavailableRemoved: 1 });
  });

  it("editar painel exige CONSULTAS_CRIAR (como criar)", async () => {
    matrixByUser["auth-fin"] = grant("CONSULTAS", ...ALL_ENTITIES, "CONSULTAS_COMPARTILHAR");
    panelFindUnique.mockResolvedValue(panelRow());
    viewFindMany.mockResolvedValue([viewRow()]);
    expect(
      (await errorOf(updatePanel(as(finUser), "p1", { name: "P", items: [{ viewId: "v1" }], sharing: "ALL" })))?.code,
    ).toBe("FORBIDDEN");
    expect(panelUpdate).not.toHaveBeenCalled();
  });

  it("dono editando painel recebe só ids que pode abrir; os demais só como contagem", async () => {
    panelFindUnique.mockResolvedValue(panelRow({ items: [{ viewId: "v1" }, { viewId: "privada-alheia" }, { viewId: "sumiu" }] }));
    viewFindMany.mockResolvedValue([viewRow(), viewRow({ id: "privada-alheia", ownerId: "db-pm", name: "Segredo" })]);
    const panel = await getPanelForViewer(as(finUser), "p1");
    expect(panel!.ownerItems).toEqual([{ viewId: "v1", size: "normal" }]);
    expect(panel!.hiddenCount).toBe(2);
    const json = JSON.stringify(panel);
    for (const secret of ["privada-alheia", "Segredo", "sumiu"]) expect(json).not.toContain(secret);
  });

  it("dono que perdeu a entidade não altera nem recompartilha a visão (404), mas pode excluir", async () => {
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm" }));
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_HORAS", "CONSULTAS_CRIAR", "CONSULTAS_COMPARTILHAR");
    const form = { name: "Renomeada", visualization: "TABLE", sharing: "ALL" };
    expect((await errorOf(updateSavedView(as(pmUser), "v1", form)))?.code).toBe("NOT_FOUND");
    // Spec que deixou de valer para o dono (campo financeiro) também → 404.
    matrixByUser["auth-pm"] = grant("CONSULTAS", "CONSULTAS_PROJETOS", "CONSULTAS_CRIAR", "CONSULTAS_COMPARTILHAR");
    viewFindUnique.mockResolvedValue(viewRow({ ownerId: "db-pm", spec: projectsFinanceSpec }));
    expect((await errorOf(updateSavedView(as(pmUser), "v1", form)))?.code).toBe("NOT_FOUND");
    expect(viewUpdate).not.toHaveBeenCalled();
    await deleteSavedView(as(pmUser), "v1");
    expect(viewDelete).toHaveBeenCalledWith({ where: { id: "v1" } });
  });

  it("alterar painel para ALL sem COMPARTILHAR → FORBIDDEN; excluir audita", async () => {
    matrixByUser["auth-fin"] = grant("CONSULTAS", ...ALL_ENTITIES, "CONSULTAS_CRIAR");
    panelFindUnique.mockResolvedValue(panelRow({ sharing: "PRIVATE" }));
    viewFindMany.mockResolvedValue([viewRow()]);
    expect(
      (await errorOf(updatePanel(as(finUser), "p1", { name: "P", items: [{ viewId: "v1" }], sharing: "ALL" })))?.code,
    ).toBe("FORBIDDEN");
    expect(panelUpdate).not.toHaveBeenCalled();

    await deletePanel(as(finUser), "p1");
    expect(panelDelete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(auditActions()).toEqual(["CONSULTA_PAINEL_EXCLUIDO"]);
  });
});
