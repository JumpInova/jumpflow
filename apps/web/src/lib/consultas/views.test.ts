import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSULTA_ENTITIES, getEntity } from "./catalog";

/**
 * Regras de negócio das views SQL de Consultas (Fase C1, testador). O banco
 * não é acessível nos testes, então conferimos o SQL da migration contra a
 * regra TS (`resolveSaleRate` em lib/projects/rates.ts, usada por
 * `resolveBillingRate` dos Relatórios): precedência, vigência e desempate.
 */

const MIGRATION = join(
  process.cwd(),
  "../../packages/database/prisma/migrations/20261127100000_consultas_fundacao/migration.sql",
);
const SQL = readFileSync(MIGRATION, "utf8");

function viewBody(view: string): string {
  const marker = `CREATE OR REPLACE VIEW "${view}" AS`;
  const start = SQL.indexOf(marker);
  expect(start, view).toBeGreaterThanOrEqual(0);
  const end = SQL.indexOf("CREATE OR REPLACE VIEW", start + marker.length);
  return SQL.slice(start, end < 0 ? undefined : end);
}

/** Bloco `COALESCE(...) AS "valor"` do valor-hora de venda. */
function saleRateBlock(body: string): string {
  const start = body.indexOf("SELECT COALESCE(");
  const end = body.indexOf(') AS "valor"', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

/** As 3 subconsultas de faixa (alocação, consultor, projeto), em ordem. */
function rateSubqueries(block: string): string[] {
  return block.split('(SELECT r."hourlyRate" FROM "ProjectSaleRate" r').slice(1);
}

describe("consulta_horas — valor-hora de venda vigente (paridade com resolveSaleRate)", () => {
  const body = viewBody("consulta_horas");
  const block = saleRateBlock(body);
  const [byAllocation, byConsultant, byProject] = rateSubqueries(block);

  it("precedência alocação → consultor → projeto → Project.billingHourlyRate → Client.defaultHourlyRate", () => {
    expect(rateSubqueries(block)).toHaveLength(3);
    const order = [
      block.indexOf('r."allocationId" = te."allocationId"'),
      block.indexOf('r."consultantId" = te."consultantId"'),
      block.indexOf('r."consultantId" IS NULL'),
      block.indexOf('p."billingHourlyRate"'),
      block.indexOf('cl."defaultHourlyRate"'),
    ];
    for (const index of order) expect(index).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("faixa por alocação só vale para lançamento com alocação", () => {
    expect(byAllocation).toContain('te."allocationId" IS NOT NULL');
    expect(byAllocation).toContain('r."allocationId" = te."allocationId"');
  });

  it("faixa do consultor exige allocationId nulo; faixa do projeto exige allocationId e consultantId nulos", () => {
    expect(byConsultant).toContain('r."allocationId" IS NULL');
    expect(byConsultant).toContain('r."consultantId" = te."consultantId"');
    expect(byProject).toContain('r."allocationId" IS NULL');
    expect(byProject).toContain('r."consultantId" IS NULL');
  });

  it.each([0, 1, 2])("faixa %i: mesmo projeto, início inclusivo, fim exclusivo, mais recente primeiro", (i) => {
    const sub = rateSubqueries(block)[i];
    expect(sub).toContain('r."projectId" = te."projectId"');
    // isActiveOn: startsAt <= data < endsAt (endsAt nulo = aberta), por dia UTC.
    expect(sub).toContain('r."startsAt"::date <= te."date"::date');
    expect(sub).toContain('(r."endsAt" IS NULL OR te."date"::date < r."endsAt"::date)');
    // newestFirst: maior startsAt (dia) vence; desempate determinístico.
    expect(sub).toMatch(/ORDER BY r\."startsAt"::date DESC[^)]*LIMIT 1/);
    // Mesma chave de desempate de newestFirst (rates.ts): maior id em ordem binária.
    expect(sub).toContain('ORDER BY r."startsAt"::date DESC, r."id" COLLATE "C" DESC');
  });

  it("receita = horas × venda só para faturável e APPROVED/CLOSED; valor bruto em qualquer situação", () => {
    expect(body).toMatch(
      /CASE WHEN te\."billable" AND te\."status" IN \('APPROVED', 'CLOSED'\)\s+THEN te\."hours" \* sr\."valor" ELSE 0 END\s+AS "receita"/,
    );
    expect(body).toContain('te."hours" * sr."valor"                   AS "valor_bruto"');
    expect(body).toMatch(/CASE WHEN te\."status" IN \('APPROVED', 'CLOSED'\) THEN te\."hours" ELSE 0 END\s+AS "horas_aprovadas"/);
  });

  it("expõe as colunas técnicas de escopo", () => {
    for (const column of ["consultant_id", "project_id", "project_manager_id", "status"]) {
      expect(body).toContain(`AS "${column}"`);
    }
  });

  it("não lê nenhuma tabela/coluna de custo cifrado", () => {
    for (const body of ["consulta_horas", "consulta_alocacoes", "consulta_consultores"].map(viewBody)) {
      expect(body).not.toMatch(
        /ConsultantProjectRate|ConsultantAllocationCostRate|ConsultantCompensation|hourlyCost/,
      );
    }
  });
});

describe("consulta_alocacoes — valor-hora atual", () => {
  const body = viewBody("consulta_alocacoes");
  const block = saleRateBlock(body);

  it("mesma precedência e vigência, avaliadas no dia de hoje em São Paulo", () => {
    expect(body).toContain(`(NOW() AT TIME ZONE 'America/Sao_Paulo')::date AS "dia"`);
    const subs = rateSubqueries(block);
    expect(subs).toHaveLength(3);
    for (const sub of subs) {
      expect(sub).toContain('r."startsAt"::date <= hoje."dia"');
      expect(sub).toContain('(r."endsAt" IS NULL OR hoje."dia" < r."endsAt"::date)');
    }
    const order = [
      block.indexOf('r."allocationId" = a."id"'),
      block.indexOf('r."consultantId" = a."consultantId"'),
      block.indexOf('r."consultantId" IS NULL'),
      block.indexOf('p."billingHourlyRate"'),
      block.indexOf('cl."defaultHourlyRate"'),
    ];
    for (const index of order) expect(index).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("consulta_consultores — escopo de PM", () => {
  it("project_manager_ids nunca é NULL (ANY sobre NULL não casa, mas o array vazio é explícito)", () => {
    expect(viewBody("consulta_consultores")).toContain(
      'COALESCE(al."project_manager_ids", ARRAY[]::text[]) AS "project_manager_ids"',
    );
  });
});

describe("métricas oficiais no catálogo (§3)", () => {
  it("Horas lançadas/aprovadas/faturáveis e Receita documentadas com fórmula", () => {
    const metrics = getEntity("horas")!.metrics ?? [];
    for (const label of ["Horas lançadas", "Horas aprovadas", "Horas faturáveis", "Receita"]) {
      const metric = metrics.find((m) => m.label === label);
      expect(metric, label).toBeDefined();
      expect(metric!.formula.length).toBeGreaterThan(5);
    }
  });

  it("Custo e Margem ficam fora das Consultas (decisão 6): nem métrica nem campo", () => {
    for (const entity of CONSULTA_ENTITIES) {
      for (const metric of entity.metrics ?? []) {
        expect(`${metric.label} ${metric.formula} ${metric.description}`, metric.label).not.toMatch(
          /custo|margem|cost|margin/i,
        );
      }
      for (const field of entity.fields) {
        expect(`${field.key} ${field.label}`, field.key).not.toMatch(/custo|margem|cost|margin/i);
        expect(field.sensitivity).not.toBe("custo_sensivel");
      }
    }
  });

  it("% de ocupação disponível em Alocações e Consultores", () => {
    for (const key of ["alocacoes", "consultores"]) {
      const entity = getEntity(key)!;
      const inFields = entity.fields.some((f) => /ocupa/i.test(`${f.label} ${f.description}`));
      const inMetrics = (entity.metrics ?? []).some((m) => /ocupa/i.test(m.label));
      expect(inFields || inMetrics, key).toBe(true);
    }
  });
});
