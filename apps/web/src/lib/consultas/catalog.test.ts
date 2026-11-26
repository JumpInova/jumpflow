import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fullControlMatrix, SYSTEM_PERMISSION_CODES } from "@/lib/auth/permission-codes";
import { buildConsultaAccess } from "./access";
import { CONSULTA_ENTITIES, fieldAggregations } from "./catalog";
import { validateConsulta } from "./validate";

const FULL = buildConsultaAccess(fullControlMatrix(), { financial: true, sensitiveCost: true });
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** SQL de todas as migrations, para conferir view ↔ catálogo. */
function migrationsSql(): string {
  const dir = join(process.cwd(), "../../packages/database/prisma/migrations");
  return readdirSync(dir)
    .filter((name) => !name.endsWith(".toml"))
    .map((name) => {
      try {
        return readFileSync(join(dir, name, "migration.sql"), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

/** Corpo da ÚLTIMA definição `CREATE OR REPLACE VIEW "<view>"`. */
function viewBody(sql: string, view: string): string {
  const marker = `CREATE OR REPLACE VIEW "${view}" AS`;
  const start = sql.lastIndexOf(marker);
  if (start < 0) return "";
  const end = sql.indexOf("CREATE OR REPLACE VIEW", start + marker.length);
  return sql.slice(start, end < 0 ? undefined : end);
}

describe("catálogo de Consultas (fonte única)", () => {
  const sql = migrationsSql();

  it("chaves únicas e identificadores seguros", () => {
    const entityKeys = CONSULTA_ENTITIES.map((e) => e.key);
    expect(new Set(entityKeys).size).toBe(entityKeys.length);
    for (const entity of CONSULTA_ENTITIES) {
      expect(entity.view).toMatch(IDENT_RE);
      const keys = entity.fields.map((f) => f.key);
      expect(new Set(keys).size, entity.key).toBe(keys.length);
      for (const field of entity.fields) {
        expect(field.key, field.key).toMatch(IDENT_RE);
        expect(field.column, field.key).toMatch(IDENT_RE);
        expect(field.key).not.toContain(":");
        expect(field.description.length).toBeGreaterThan(5);
        expect(field.source.length).toBeGreaterThan(3);
        if (field.type === "lista") expect(field.options?.length, field.key).toBeGreaterThan(0);
        expect(fieldAggregations(field)).toContain("count");
      }
    }
  });

  it("cada entidade aponta para um code nativo da Matriz", () => {
    for (const entity of CONSULTA_ENTITIES) {
      expect(SYSTEM_PERMISSION_CODES.has(entity.permissionCode), entity.key).toBe(true);
    }
  });

  it("toda coluna do catálogo existe na view da migration (inclui colunas de escopo)", () => {
    for (const entity of CONSULTA_ENTITIES) {
      const body = viewBody(sql, entity.view);
      expect(body, entity.view).not.toBe("");
      const columns = [
        ...entity.fields.map((f) => f.column),
        "id",
        "consultant_id",
        entity.scope === "pessoa_projetos" ? "project_manager_ids" : "project_manager_id",
        ...(entity.financeStatusColumn ? [entity.financeStatusColumn] : []),
        ...(entity.detail ? [entity.detail.column] : []),
      ];
      for (const column of columns) {
        expect(body, `${entity.view}.${column}`).toContain(`AS "${column}"`);
      }
    }
  });

  it("não expõe dados pessoais nem custo cifrado", () => {
    const forbidden = /cpf|\brg\b|_rg|banc|bank|endereco|address|salario|remunera|hourlycost|custo/i;
    for (const entity of CONSULTA_ENTITIES) {
      for (const field of entity.fields) {
        expect(`${field.key} ${field.column}`, field.key).not.toMatch(forbidden);
      }
    }
  });

  it("colunas padrão e exemplos são consultas válidas", () => {
    for (const entity of CONSULTA_ENTITIES) {
      for (const key of entity.defaultColumns) {
        expect(entity.fields.some((f) => f.key === key), key).toBe(true);
      }
      for (const example of entity.examples) {
        expect(() => validateConsulta(example.spec, FULL), example.label).not.toThrow();
      }
    }
  });
});
