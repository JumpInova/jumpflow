/**
 * Servidor do módulo Consultas: resolve acesso (matriz + colunas) e escopo de
 * linha do usuário REAL, valida, compila e executa a consulta com timeout,
 * e audita (ESPECIFICAÇÃO §4). Tela, server actions e rota de exportação
 * passam todos por aqui — nunca há um caminho que pule a checagem.
 *
 * Assume banco configurado: os chamadores checam `isDatabaseConfigured()`.
 */
import { Prisma, prisma } from "@jumpflow/database";
import type { AppUser } from "@/lib/auth/types";
import { getCurrentMatrix } from "@/lib/auth/permissions";
import { canAccessSensitiveCost } from "@/lib/auth/sensitive-data";
import { resolveReportScope } from "@/lib/db/reports";
import { recordAuditEvent } from "@/lib/db/audit";
import { resolveDbUser } from "@/lib/db/users";
import {
  buildConsultaAccess,
  NO_CONSULTA_ACCESS,
  type ConsultaAccess,
} from "@/lib/consultas/access";
import {
  compileConsulta,
  type OutputColumn,
  type RowScope,
} from "@/lib/consultas/compile";
import { ConsultaError } from "@/lib/consultas/errors";
import {
  exportRowLimit,
  mapRow,
  resolveScreenPage,
  type ResultRow,
} from "@/lib/consultas/result";
import { validateConsulta, type ValidatedConsulta } from "@/lib/consultas/validate";

/** Timeout de cada execução (SET LOCAL dentro da transação). */
export const STATEMENT_TIMEOUT = "15s";
/** Teto da transação interativa do Prisma (acima do statement_timeout). */
const TRANSACTION_TIMEOUT_MS = 20_000;

export interface ConsultaContext {
  access: ConsultaAccess;
  scope: RowScope;
}

/** Acesso + escopo do usuário real. Falha fechada (sem acesso) em erro. */
export async function getConsultaContext(user: AppUser): Promise<ConsultaContext> {
  try {
    const [matrix, reportScope] = await Promise.all([
      getCurrentMatrix(),
      resolveReportScope(user),
    ]);
    return {
      access: buildConsultaAccess(matrix, {
        financial: reportScope.includeFinancials,
        sensitiveCost: canAccessSensitiveCost(user),
        financeHoursLimited: reportScope.financeHoursLimited,
      }),
      scope: {
        broad: reportScope.broad,
        managerUserId: reportScope.managerUserId,
        ownConsultantId: reportScope.ownConsultantId,
        financeHoursLimited: reportScope.financeHoursLimited,
      },
    };
  } catch (error) {
    console.error("[consultas] falha ao resolver acesso; negando", error);
    return {
      access: NO_CONSULTA_ACCESS,
      scope: { broad: false, financeHoursLimited: false },
    };
  }
}

function isTimeout(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /statement timeout|canceling statement|57014/i.test(text);
}

type RawRow = Record<string, unknown>;

/**
 * Executa as consultas compiladas numa transação com `statement_timeout`.
 * `SET LOCAL` vale só para esta transação (seguro com pool/pgbouncer).
 */
async function runInTimeout<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SET LOCAL statement_timeout = ${Prisma.raw(`'${STATEMENT_TIMEOUT}'`)}`,
        );
        return work(tx);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: 5_000 },
    );
  } catch (error) {
    if (isTimeout(error)) {
      throw new ConsultaError(
        "TIMEOUT",
        "A consulta demorou demais. Adicione filtros (por exemplo, um período menor) e tente de novo.",
      );
    }
    console.error("[consultas] falha ao executar", error);
    throw new ConsultaError("FAILED", "Não foi possível executar a consulta.");
  }
}

async function auditSensitiveRun(
  user: AppUser,
  validated: ValidatedConsulta,
  action: "CONSULTA_EXECUTADA_SENSIVEL" | "CONSULTA_EXPORTADA",
  extra: Record<string, unknown>,
): Promise<void> {
  const dbUser = await resolveDbUser(user).catch(() => null);
  await recordAuditEvent({
    actorUserId: dbUser?.id ?? null,
    entityType: "Consulta",
    entityId: validated.entity.key,
    action,
    after: { spec: validated.spec, usesSensitive: validated.usesSensitive, ...extra },
  });
}

export interface ConsultaRunResult {
  entity: string;
  grouped: boolean;
  columns: Omit<OutputColumn, "alias">[];
  /** Medidas da faixa de totais (sobre todo o conjunto filtrado). */
  measures: Omit<OutputColumn, "alias">[];
  rows: (ResultRow & { _href?: string })[];
  totals: ResultRow | null;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Total real de linhas/grupos do filtro. */
  totalRows: number;
  /** Linhas navegáveis na tela (≤ 1000). */
  navigableRows: number;
  detailLabel?: string;
}

function publicColumns(columns: OutputColumn[]): Omit<OutputColumn, "alias">[] {
  return columns.map((column) => {
    const rest: Omit<OutputColumn, "alias"> & { alias?: string } = { ...column };
    delete rest.alias;
    return rest;
  });
}

/**
 * Origem da spec. `adhoc` = montada pelo usuário no construtor (exige
 * `CONSULTAS_CRIAR`). `saved_view` = spec lida NO SERVIDOR de uma visão salva
 * que o usuário pode abrir (C2) — nunca uma alegação do cliente; não exige
 * CRIAR, mas segue exigindo entidade/campos/escopo de quem vê.
 */
export type ConsultaOrigin = "adhoc" | "saved_view";

function requireCreateFor(context: ConsultaContext, origin: ConsultaOrigin): void {
  if (origin === "adhoc" && !context.access.create) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Você não tem permissão para criar consultas.",
    );
  }
}

function prepare(context: ConsultaContext, raw: unknown, origin: ConsultaOrigin) {
  requireCreateFor(context, origin);
  return validateConsulta(raw, context.access);
}

/** Metadados de auditoria quando a spec vem de uma visão salva. */
export interface ConsultaRunMeta {
  viewId?: string;
}

/**
 * Roda a consulta para a TELA: página de 100, até 1000 linhas navegáveis.
 * `origin: "saved_view"` só pode ser usado por quem carregou a spec NO
 * SERVIDOR (lib/db/consultas-saved.ts) — nunca repasse a origem do cliente.
 */
export async function runConsulta(
  user: AppUser,
  raw: unknown,
  page = 1,
  origin: ConsultaOrigin = "adhoc",
  meta: ConsultaRunMeta = {},
  preloaded?: ConsultaContext,
): Promise<ConsultaRunResult> {
  const context = preloaded ?? (await getConsultaContext(user));
  const validated = prepare(context, raw, origin);
  const compiled = compileConsulta(validated.entity, validated.spec, context.scope);
  const window = resolveScreenPage(page, validated.spec.limit);

  const { rawRows, total, rawTotals } = await runInTimeout(async (tx) => {
    const rawRows =
      window.take > 0
        ? await tx.$queryRaw<RawRow[]>(compiled.rows(window.offset, window.take))
        : [];
    const [{ total }] = await tx.$queryRaw<{ total: number }[]>(compiled.count);
    const rawTotals = compiled.totals
      ? (await tx.$queryRaw<RawRow[]>(compiled.totals))[0] ?? null
      : null;
    return { rawRows, total: Number(total), rawTotals };
  });

  if (validated.usesSensitive) {
    await auditSensitiveRun(user, validated, "CONSULTA_EXECUTADA_SENSIVEL", {
      page: window.page,
      totalRows: total,
      origin,
      ...(meta.viewId ? { viewId: meta.viewId } : {}),
    });
  }

  const detail = compiled.detail;
  const rows = rawRows.map((rawRow) => {
    const row: ResultRow & { _href?: string } = mapRow(rawRow, compiled.columns);
    const target = rawRow._detail;
    if (detail && typeof target === "string" && target) {
      row._href = `${detail.hrefPrefix}${encodeURIComponent(target)}`;
    }
    return row;
  });
  const navigableRows = Math.min(total, window.maxRows);

  return {
    entity: validated.entity.key,
    grouped: compiled.grouped,
    columns: publicColumns(compiled.columns),
    measures: publicColumns(compiled.measures),
    rows,
    totals: rawTotals ? mapRow(rawTotals, compiled.measures) : null,
    page: window.page,
    pageSize: window.pageSize,
    pageCount: Math.max(1, Math.ceil(navigableRows / window.pageSize)),
    totalRows: total,
    navigableRows,
    ...(detail ? { detailLabel: detail.label } : {}),
  };
}

export interface ConsultaExportData {
  validated: ValidatedConsulta;
  columns: OutputColumn[];
  measures: OutputColumn[];
  rows: ResultRow[];
  totals: ResultRow | null;
  truncated: boolean;
}

/**
 * Linhas para EXPORTAÇÃO (até 50.000). Exige `CONSULTAS_EXPORTAR` + acesso à
 * entidade/campos (e escopo de quem exporta); `CONSULTAS_CRIAR` só quando a
 * spec é ad hoc (`origin: "adhoc"`, a rota do construtor). Sempre auditada.
 */
export async function exportConsulta(
  user: AppUser,
  raw: unknown,
  format: "xlsx" | "csv",
  origin: ConsultaOrigin,
  meta: ConsultaRunMeta = {},
  preloaded?: ConsultaContext,
): Promise<ConsultaExportData> {
  const context = preloaded ?? (await getConsultaContext(user));
  if (!context.access.export) {
    throw new ConsultaError(
      "FORBIDDEN",
      "Você não tem permissão para exportar resultados.",
    );
  }
  const validated = prepare(context, raw, origin);
  const compiled = compileConsulta(validated.entity, validated.spec, context.scope);
  const limit = exportRowLimit(validated.spec.limit);

  const { rawRows, total, rawTotals } = await runInTimeout(async (tx) => {
    const rawRows = await tx.$queryRaw<RawRow[]>(compiled.rows(0, limit));
    const [{ total }] = await tx.$queryRaw<{ total: number }[]>(compiled.count);
    const rawTotals = compiled.totals
      ? (await tx.$queryRaw<RawRow[]>(compiled.totals))[0] ?? null
      : null;
    return { rawRows, total: Number(total), rawTotals };
  });

  await auditSensitiveRun(user, validated, "CONSULTA_EXPORTADA", {
    format,
    origin,
    ...(meta.viewId ? { viewId: meta.viewId } : {}),
    rowCount: rawRows.length,
    totalRows: total,
  });

  return {
    validated,
    columns: compiled.columns,
    measures: compiled.measures,
    rows: rawRows.map((rawRow) => mapRow(rawRow, compiled.columns)),
    totals: rawTotals ? mapRow(rawTotals, compiled.measures) : null,
    truncated: total > rawRows.length,
  };
}
