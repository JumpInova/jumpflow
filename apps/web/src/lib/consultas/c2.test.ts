import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateRolePermissions, fullControlMatrix } from "@/lib/auth/permission-codes";
import { buildConsultaAccess, visibleCatalog } from "./access";
import { CONSULTA_ENTITIES, getEntity } from "./catalog";
import { compileConsulta, scopeSql } from "./compile";
import { ConsultaError } from "./errors";
import { validateConsulta } from "./validate";

/**
 * Fase C2: ressalvas do validador da C1 (métricas por sensibilidade, Atividade
 * legada, descrição de horas aprovadas) e regras das entidades novas.
 */

const MIGRATIONS = join(process.cwd(), "../../packages/database/prisma/migrations");
const C2_DIR = "20261128100000_consultas_abrangencia_visoes";
const C2_SQL = readFileSync(join(MIGRATIONS, C2_DIR, "migration.sql"), "utf8");
/** SQL sem comentários `--` (os comentários citam tabelas de custo de propósito). */
const C2_CODE = C2_SQL.split("\n")
  .map((line) => line.replace(/--.*$/, ""))
  .join("\n");

const FULL = buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: true });
const NO_FINANCE = buildConsultaAccess(fullControlMatrix(), { financial: false, sensitiveCost: false });

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConsultaError ? error.code : "OTHER";
  }
  return undefined;
}

const activity = (op: "eq" | "in", value: unknown) => ({
  entity: "horas",
  filters: { logic: "and", conditions: [{ field: "atividade", op, value }] },
  columns: ["data"],
  groupBy: [],
  measures: [],
  sort: [],
});

describe("ressalva 1 (C1): métricas filtradas por sensibilidade", () => {
  it("toda métrica declara sensibilidade", () => {
    for (const entity of CONSULTA_ENTITIES) {
      for (const metric of entity.metrics ?? []) {
        expect(["publico", "financeiro", "custo_sensivel"], `${entity.key}: ${metric.label}`).toContain(
          metric.sensitivity,
        );
      }
    }
  });

  it("sem finanças, nenhuma métrica financeira chega ao catálogo visível (nem à IA)", () => {
    const hidden = visibleCatalog(NO_FINANCE).flatMap((entity) => entity.metrics ?? []);
    expect(hidden.some((metric) => metric.sensitivity !== "publico")).toBe(false);
    expect(hidden.some((metric) => metric.label === "Receita")).toBe(false);
    const full = visibleCatalog(FULL).flatMap((entity) => entity.metrics ?? []);
    expect(full.some((metric) => metric.label === "Receita")).toBe(true);
  });
});

describe("ressalva 2 (C1): Atividade aceita valores legados", () => {
  it("códigos legados valem em eq/in e aparecem com rótulo “(legado)”", () => {
    expect(codeOf(() => validateConsulta(activity("eq", "DEVELOPMENT"), FULL))).toBeUndefined();
    expect(codeOf(() => validateConsulta(activity("in", ["DEVELOPMENT", "WORKDAY"]), FULL))).toBeUndefined();
    const field = getEntity("horas")!.fields.find((f) => f.key === "atividade")!;
    expect(field.options?.find((o) => o.value === "DEVELOPMENT")?.label).toContain("(legado)");
  });

  it("lista aberta só aceita forma de código; outras listas continuam fechadas", () => {
    // Código desconhecido com forma válida passa (pode existir em dado antigo).
    expect(codeOf(() => validateConsulta(activity("eq", "OLD_CODE_2019"), FULL))).toBeUndefined();
    for (const bad of ["development", "x'; DROP TABLE y; --", "", "A".repeat(80)]) {
      expect(codeOf(() => validateConsulta(activity("eq", bad), FULL)), bad).toBe("INVALID");
    }
    const status = { ...activity("eq", "OLD_CODE"), filters: { logic: "and", conditions: [{ field: "status", op: "eq", value: "OLD_CODE" }] } };
    expect(codeOf(() => validateConsulta(status, FULL))).toBe("INVALID");
  });
});

describe("ressalva 4 (C1): horas aprovadas em Alocações", () => {
  it("descrição explicita que só soma lançamentos vinculados à alocação", () => {
    const field = getEntity("alocacoes")!.fields.find((f) => f.key === "horas_aprovadas")!;
    expect(field.description).toMatch(/vinculados/i);
    expect(field.description).toMatch(/sem alocação/i);
  });
});

describe("C2: entidades novas", () => {
  const expected: Record<string, { code: string; scope: string }> = {
    projetos: { code: "CONSULTAS_PROJETOS", scope: "projeto" },
    aprovacoes: { code: "CONSULTAS_APROVACOES", scope: "pessoa_projeto" },
    despesas: { code: "CONSULTAS_DESPESAS", scope: "pessoa_projeto" },
    faturamento: { code: "CONSULTAS_FATURAMENTO", scope: "projeto" },
    pagamentos: { code: "CONSULTAS_PAGAMENTOS", scope: "amplo" },
    skills: { code: "CONSULTAS_SKILLS", scope: "pessoa_projetos" },
    certificados: { code: "CONSULTAS_SKILLS", scope: "pessoa_projetos" },
    ausencias: { code: "CONSULTAS_AUSENCIAS", scope: "pessoa_projetos" },
  };

  it.each(Object.entries(expected))("%s: code da matriz e tipo de escopo", (key, rule) => {
    const entity = getEntity(key);
    expect(entity, key).toBeDefined();
    expect(entity!.permissionCode).toBe(rule.code);
    expect(entity!.scope).toBe(rule.scope);
    expect(C2_SQL).toContain(`CREATE OR REPLACE VIEW "${entity!.view}" AS`);
  });

  it("Pagamentos: fora do escopo amplo dos Relatórios → nenhuma linha (PM, consultor)", () => {
    const pagamentos = getEntity("pagamentos")!;
    expect(scopeSql(pagamentos, { broad: false, managerUserId: "pm", financeHoursLimited: false }).text).toBe("FALSE");
    expect(scopeSql(pagamentos, { broad: false, ownConsultantId: "c", financeHoursLimited: false }).text).toBe("FALSE");
    expect(scopeSql(pagamentos, { broad: true, financeHoursLimited: true }).text).toBe("TRUE");
  });

  it("Projetos/Faturamento: PM pelos próprios projetos; “próprio consultor” não alcança linha de projeto", () => {
    for (const key of ["projetos", "faturamento"]) {
      const entity = getEntity(key)!;
      const pm = scopeSql(entity, { broad: false, managerUserId: "pm", financeHoursLimited: false });
      expect(pm.text).toBe('"project_manager_id" = $1');
      expect(pm.values).toEqual(["pm"]);
      expect(scopeSql(entity, { broad: false, ownConsultantId: "c", financeHoursLimited: false }).text).toBe("FALSE");
    }
  });

  it("Projetos: horas lançadas (qualquer situação) ficam ocultas para o escopo do Financeiro", () => {
    const projetos = getEntity("projetos")!;
    const limited = buildConsultaAccess(fullControlMatrix(), {
      financial: true,
      sensitiveCost: false,
      financeHoursLimited: true,
    });
    const spec = { entity: "projetos", filters: null, columns: ["projeto", "horas_lancadas"], groupBy: [], measures: [], sort: [] };
    expect(codeOf(() => validateConsulta(spec, limited))).toBe("FORBIDDEN");
    expect(visibleCatalog(limited).find((e) => e.key === "projetos")!.fields.some((f) => f.key === "horas_lancadas")).toBe(false);
    expect(projetos.fields.find((f) => f.key === "horas_aprovadas")?.financeRestricted).toBeFalsy();
  });

  it("valores de faturamento, pagamento e orçamento são `financeiro` (somem sem FINANCIAL_ROLES)", () => {
    const financial = {
      faturamento: ["valor_bruto", "ajuste", "valor_total"],
      pagamentos: ["valor_total", "valor_nf"],
      projetos: ["horas_orcadas", "consumo_orcamento", "valor_hora_padrao"],
    };
    for (const [key, fields] of Object.entries(financial)) {
      const entity = getEntity(key)!;
      for (const field of fields) {
        expect(entity.fields.find((f) => f.key === field)?.sensitivity, `${key}.${field}`).toBe("financeiro");
      }
      const visible = visibleCatalog(NO_FINANCE).find((e) => e.key === key)!;
      for (const field of fields) expect(visible.fields.some((f) => f.key === field)).toBe(false);
    }
  });

  it("Skills e Certificados dividem CONSULTAS_SKILLS: sem ele, nenhum dos dois", () => {
    const access = buildConsultaAccess(
      aggregateRolePermissions(
        ["CONSULTAS", "CONSULTAS_AUSENCIAS"].map((code) => ({
          code,
          canView: true,
          canCreate: false,
          canEdit: false,
          canDelete: false,
        })),
      ),
      { financial: true, sensitiveCost: true },
    );
    const keys = visibleCatalog(access).map((e) => e.key);
    expect(keys).toEqual(["ausencias"]);
  });

  it("toda entidade nova compila (lista e agrupada) com escopo de PM", () => {
    for (const key of Object.keys(expected)) {
      const entity = getEntity(key)!;
      const groupable = entity.fields.find((f) => f.groupable && f.sensitivity === "publico")!;
      const { spec } = validateConsulta(
        { entity: key, filters: null, columns: [], groupBy: [{ field: groupable.key }], measures: [{ field: groupable.key, agg: "count" }], sort: [] },
        FULL,
      );
      const compiled = compileConsulta(entity, spec, { broad: false, managerUserId: "pm", financeHoursLimited: false });
      expect(compiled.rows(0, 10).text).toContain(`FROM "${entity.view}"`);
    }
  });
});

describe("C2: migration (aditiva e sem custo cifrado)", () => {
  it("timestamp maior que o da migration anterior", () => {
    const dirs = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
    // A C2 vem logo depois da C1 (as fases seguintes, como a C3, vêm depois dela).
    const c2 = dirs.indexOf(C2_DIR);
    expect(c2).toBeGreaterThan(0);
    expect(dirs[c2 - 1]).toBe("20261127100000_consultas_fundacao");
  });

  it("nenhuma view lê tabela de custo cifrado, linhas de pagamento ou dado pessoal", () => {
    for (const forbidden of [
      "ConsultantCompensation",
      "ConsultantBenefit",
      "ConsultantAllocationCostRate",
      "ConsultantProjectRate",
      "ConsultantAdHocPayment",
      "ConsultantPaymentLine",
      "ConsultantBankAccount",
      "ConsultantPersonalInfo",
      "ConsultantAddress",
      '"hourlyCost"',
      '"originAddress"',
      '"destinationAddress"',
      '"decisionComment"',
      '"note"',
      '"cltNetAmount"',
      '"pjAmount"',
      '"benefitAmount"',
    ]) {
      expect(C2_CODE, forbidden).not.toContain(forbidden);
    }
  });

  it("Pagamentos só PJ/CLT FLEX (igual à tela); comentário de ausência não sai em Aprovações", () => {
    expect(C2_CODE).toContain(`WHERE cp."contractType" IN ('PJ', 'CLT_FLEX')`);
    expect(C2_CODE).toContain(`CASE WHEN ap."entityType" <> 'TIME_OFF' THEN ap."comment" END`);
  });

  it("aditiva: sem DROP/TRUNCATE/DELETE nem ALTER de tabela existente", () => {
    // "ON DELETE/ON UPDATE CASCADE" das FKs novas é permitido.
    expect(C2_CODE).not.toMatch(/\bDROP\b|\bTRUNCATE\b|(?<!ON )\bDELETE\b|(?<!ON )\bUPDATE\b/i);
    const altered = [...C2_CODE.matchAll(/ALTER TABLE "([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(altered)).toEqual(new Set(["ConsultaView", "ConsultaPanel"]));
    expect(C2_CODE).toContain('CREATE TABLE "ConsultaView"');
    expect(C2_CODE).toContain('CREATE TABLE "ConsultaPanel"');
  });
});
