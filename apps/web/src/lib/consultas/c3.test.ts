import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Fase C3: migration aditiva + correções de fuso/negativo nas views da C1/C2. */
const MIGRATIONS = path.resolve(__dirname, "../../../../../packages/database/prisma/migrations");
const C1 = "20261127100000_consultas_fundacao";
const C2 = "20261128100000_consultas_abrangencia_visoes";
const C3 = "20261129100000_consultas_ia_agendamento";
const read = (dir: string) => readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");
const code = (sql: string) => sql.replace(/--.*$/gm, "");

describe("C3: migration", () => {
  it("vem depois da C2 e é aditiva (sem DROP/ALTER COLUMN/DELETE)", () => {
    const dirs = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
    expect(dirs.indexOf(C3)).toBe(dirs.indexOf(C2) + 1);
    const sql = code(read(C3));
    expect(sql).not.toMatch(/\bDROP\b|DELETE\s+FROM|\bTRUNCATE\b|ALTER\s+COLUMN|RENAME/i);
  });

  it("idempotência por janela e rate limit atômico têm UNIQUE no banco; alvo é visão XOR painel", () => {
    const sql = read(C3);
    expect(sql).toContain('CREATE UNIQUE INDEX "ConsultaScheduleRun_scheduleId_windowKey_key" ON "ConsultaScheduleRun"("scheduleId", "windowKey")');
    expect(sql).toContain('CREATE UNIQUE INDEX "ConsultaAiUsage_userId_windowStart_key" ON "ConsultaAiUsage"("userId", "windowStart")');
    expect(sql).toContain('CHECK (num_nonnulls("viewId", "panelId") = 1)');
    expect(sql).toContain('CHECK ("hour" BETWEEN 0 AND 23)');
    expect(sql).toContain('CHECK ("weekday" IS NULL OR "weekday" BETWEEN 1 AND 7)');
    expect(sql).toContain('CHECK ("monthDay" IS NULL OR "monthDay" BETWEEN 1 AND 31)');
    expect(sql).toContain('"claimToken" TEXT');
    // Nenhuma coluna guarda o texto do pedido à IA.
    expect(sql).not.toMatch(/"(prompt|request|text|pedido)"/i);
  });
});

describe("C1/C2: instantes viram data no fuso de São Paulo (ressalva 1 da C2)", () => {
  it("nenhum `createdAt`/`updatedAt` convertido direto com ::date (UTC)", () => {
    for (const dir of [C1, C2]) {
      const sql = code(read(dir));
      expect(sql).not.toMatch(/"(createdAt|updatedAt)"::date/);
    }
    expect(read(C1)).toContain(`((c."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS "cadastrado_em"`);
    expect(read(C2)).toContain(`((p."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS "cadastrado_em"`);
    expect(read(C2)).toContain(`((cs."updatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date AS "atualizado_em"`);
    expect(read(C2)).toContain(`((cs."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo')::date)`);
  });

  it("horas_ate_decisao nunca é negativo (reenvio após a decisão → NULL)", () => {
    const sql = read(C2);
    expect(sql).toMatch(/CASE WHEN ap\."createdAt" >= COALESCE\(te\."submittedAt", ex\."submittedAt", tf\."requestedAt"\)/);
  });
});
