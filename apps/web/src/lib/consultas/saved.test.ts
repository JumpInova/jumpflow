import { describe, expect, it } from "vitest";
import { aggregateRolePermissions, CONSULTAS_CODES } from "@/lib/auth/permission-codes";
import { buildConsultaAccess } from "./access";
import {
  canOpenShared,
  canOpenView,
  MAX_PANEL_ITEMS,
  panelInputSchema,
  parsePanelItems,
  sharingAllowed,
  specUsableBy,
  viewInputSchema,
  type Viewer,
} from "./saved";

function access(codes: string[], financial = false) {
  return buildConsultaAccess(
    aggregateRolePermissions(
      codes.map((code) => ({ code, canView: true, canCreate: false, canEdit: false, canDelete: false })),
    ),
    { financial, sensitiveCost: false },
  );
}

const HOURS = access([CONSULTAS_CODES.module, CONSULTAS_CODES.hours]);
const owner: Viewer = { userId: "u-owner", roles: ["FINANCE"] };
const pm: Viewer = { userId: "u-pm", roles: ["PROJECT_MANAGER"] };
const admin: Viewer = { userId: "u-admin", roles: ["ADMIN"] };
const unresolved: Viewer = { userId: null, roles: ["PROJECT_MANAGER"] };

const view = (sharing: "PRIVATE" | "ROLES" | "ALL", sharedRoles: string[] = [], entity = "horas") => ({
  ownerId: "u-owner",
  sharing,
  sharedRoles,
  entity,
});

const hoursSpec = (columns: string[]) => ({
  entity: "horas",
  filters: null,
  columns,
  groupBy: [],
  measures: [],
  sort: [],
});

describe("compartilhamento: quem abre", () => {
  it("dono sempre abre a própria visão", () => {
    expect(canOpenShared(view("PRIVATE"), owner)).toBe(true);
  });

  it("visão privada de outro dono não abre — nem para ADMIN (sem override por papel global)", () => {
    expect(canOpenShared(view("PRIVATE"), pm)).toBe(false);
    expect(canOpenShared(view("PRIVATE"), admin)).toBe(false);
  });

  it("usuário não resolvido no banco nunca é tratado como dono", () => {
    expect(canOpenShared({ ...view("PRIVATE"), ownerId: "" }, { userId: null, roles: [] })).toBe(false);
    expect(canOpenShared(view("PRIVATE"), unresolved)).toBe(false);
  });

  it("ROLES abre só para quem tem um dos papéis", () => {
    expect(canOpenShared(view("ROLES", ["PROJECT_MANAGER"]), pm)).toBe(true);
    expect(canOpenShared(view("ROLES", ["PEOPLE"]), pm)).toBe(false);
    expect(canOpenShared(view("ROLES", ["PEOPLE"]), admin)).toBe(false);
  });

  it("ALL abre para qualquer pessoa (o módulo e a entidade ainda são exigidos)", () => {
    expect(canOpenShared(view("ALL"), pm)).toBe(true);
  });

  it("canOpenView exige o módulo e a entidade de quem vê", () => {
    expect(canOpenView(view("ALL"), pm, HOURS)).toBe(true);
    expect(canOpenView(view("ALL", [], "despesas"), pm, HOURS)).toBe(false);
    expect(canOpenView(view("ALL"), pm, access([CONSULTAS_CODES.hours]))).toBe(false);
    // Nem o dono abre a própria visão se perdeu a entidade.
    expect(canOpenView(view("PRIVATE"), owner, access([CONSULTAS_CODES.module]))).toBe(false);
  });
});

describe("spec roda com a permissão de quem vê", () => {
  it("campo financeiro torna a visão indisponível para quem não vê finanças", () => {
    const spec = hoursSpec(["data", "receita"]);
    expect(specUsableBy(spec, access([CONSULTAS_CODES.module, CONSULTAS_CODES.hours], true))).toBe(true);
    expect(specUsableBy(spec, HOURS)).toBe(false);
  });

  it("spec corrompida no banco é indisponível (não quebra a listagem)", () => {
    expect(specUsableBy({ entity: "horas", sql: "SELECT 1" }, HOURS)).toBe(false);
    expect(specUsableBy(null, HOURS)).toBe(false);
  });

  it("compartilhar exige CONSULTAS_COMPARTILHAR; privado não", () => {
    const share = access([CONSULTAS_CODES.module, CONSULTAS_CODES.share]);
    expect(sharingAllowed("PRIVATE", HOURS)).toBe(true);
    expect(sharingAllowed("ROLES", HOURS)).toBe(false);
    expect(sharingAllowed("ALL", HOURS)).toBe(false);
    expect(sharingAllowed("ALL", share)).toBe(true);
  });
});

describe("entrada de visão e painel (Zod)", () => {
  const base = { name: "  Horas do mês ", visualization: "BAR", sharing: "PRIVATE", sharedRoles: [] };

  it("normaliza nome/descrição e zera papéis fora de ROLES", () => {
    const parsed = viewInputSchema.parse({ ...base, description: "", sharing: "ALL", sharedRoles: ["ADMIN"] });
    expect(parsed.name).toBe("Horas do mês");
    expect(parsed.description).toBeNull();
    expect(parsed.sharedRoles).toEqual([]);
  });

  it("ROLES exige ao menos um papel válido e remove duplicatas", () => {
    expect(viewInputSchema.safeParse({ ...base, sharing: "ROLES", sharedRoles: [] }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, sharing: "ROLES", sharedRoles: ["ROOT"] }).success).toBe(false);
    expect(viewInputSchema.parse({ ...base, sharing: "ROLES", sharedRoles: ["PEOPLE", "PEOPLE"] }).sharedRoles).toEqual([
      "PEOPLE",
    ]);
  });

  it("recusa nome vazio, visualização inventada e chaves extras", () => {
    expect(viewInputSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, visualization: "MAPA" }).success).toBe(false);
    expect(viewInputSchema.safeParse({ ...base, ownerId: "outro" }).success).toBe(false);
  });

  it(`painel: 1 a ${MAX_PANEL_ITEMS} visões, sem repetição`, () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ viewId: `v${i}` }));
    const panel = { name: "P", sharing: "PRIVATE", items: items(2) };
    expect(panelInputSchema.parse(panel).items[0].size).toBe("normal");
    expect(panelInputSchema.safeParse({ ...panel, items: [] }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...panel, items: items(MAX_PANEL_ITEMS) }).success).toBe(true);
    expect(panelInputSchema.safeParse({ ...panel, items: items(MAX_PANEL_ITEMS + 1) }).success).toBe(false);
    expect(panelInputSchema.safeParse({ ...panel, items: [{ viewId: "a" }, { viewId: "a" }] }).success).toBe(false);
  });

  it("itens gravados: lixo e duplicatas descartados, teto de 24", () => {
    const raw = [
      { viewId: "a", size: "largo" },
      { viewId: "a" },
      { viewId: 42 },
      "x",
      { viewId: "b", size: "gigante" },
      ...Array.from({ length: 40 }, (_, i) => ({ viewId: `v${i}` })),
    ];
    const items = parsePanelItems(raw);
    expect(items[0]).toEqual({ viewId: "a", size: "largo" });
    expect(items.some((item) => item.viewId === "b")).toBe(false);
    expect(items.length).toBeLessThanOrEqual(MAX_PANEL_ITEMS);
    expect(parsePanelItems({ not: "array" })).toEqual([]);
  });
});
