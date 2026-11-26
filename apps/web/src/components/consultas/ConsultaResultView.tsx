"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, SearchX, TableProperties, TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatCell } from "@/lib/consultas/format";
import { MAX_SCREEN_ROWS } from "@/lib/consultas/spec";
import type { ConsultaEntity } from "@/lib/consultas/types";
import type { ConsultaRunResult } from "@/lib/db/consultas";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

const NUMBER = new Intl.NumberFormat("pt-BR");

const numericTypes = new Set(["numero", "moeda", "horas"]);

export interface ConsultaResultViewProps {
  entity: ConsultaEntity;
  result: ConsultaRunResult | null;
  error: string | null;
  pending: boolean;
  onPage: (page: number) => void;
}

/**
 * Resultado da consulta: tabela paginada (100 por página, até 1000 navegáveis),
 * faixa de totais e estados vazio/erro/carregando. Linha não agrupada leva à
 * página de detalhe quando a entidade tiver uma.
 */
export function ConsultaResultView({
  entity,
  result,
  error,
  pending,
  onPage,
}: ConsultaResultViewProps) {
  if (error) {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-md border-2 border-danger bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
      >
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p>{error}</p>
      </div>
    );
  }

  if (!result) {
    return pending ? (
      <p aria-live="polite" className="rounded-md border border-border bg-surface px-4 py-10 text-center text-sm text-medium">
        Executando a consulta…
      </p>
    ) : (
      <EmptyState
        icon={TableProperties}
        title="Monte sua consulta"
        description="Escolha a entidade, filtros, colunas ou agrupamentos e clique em Executar."
      />
    );
  }

  const measures = result.measures;
  const truncated = result.totalRows > result.navigableRows;

  return (
    <div className={cn("space-y-3 transition-opacity", pending && "opacity-60")} aria-busy={pending}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-medium" aria-live="polite">
        <p>
          <span className="font-semibold text-strong">{NUMBER.format(result.totalRows)}</span>{" "}
          {result.grouped
            ? result.totalRows === 1 ? "grupo" : "grupos"
            : result.totalRows === 1 ? "registro" : "registros"}
          {truncated
            ? ` · a tela mostra os primeiros ${NUMBER.format(result.navigableRows)} (máx. ${NUMBER.format(MAX_SCREEN_ROWS)}); exporte para ver todos`
            : null}
        </p>
        {pending ? <p>Atualizando…</p> : null}
      </div>

      {result.totals && measures.length > 0 ? (
        <dl
          aria-label={result.grouped ? "Total geral" : "Totais"}
          className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {measures.map((column) => (
            <div
              key={column.key}
              className="rounded-md border-2 border-ink bg-surface px-3 py-2 shadow-[2px_2px_0_0_var(--color-ink)]"
            >
              <dt className="text-xs font-semibold uppercase tracking-wide text-soft">
                {column.label}
              </dt>
              <dd className="mt-0.5 text-lg font-semibold tabular-nums text-strong">
                {formatCell(entity, column, result.totals?.[column.key] ?? null)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {result.rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Nenhum registro encontrado"
          description="Nenhum registro do seu escopo atende aos filtros. Ajuste os filtros e execute de novo."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Resultado da consulta de {entity.label}</caption>
            <thead className="bg-surface-muted text-xs uppercase tracking-wide text-soft">
              <tr>
                {result.columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      "whitespace-nowrap px-3 py-2 font-semibold",
                      numericTypes.has(column.type) || column.agg === "count" ? "text-right" : null,
                    )}
                  >
                    {column.label}
                  </th>
                ))}
                {result.detailLabel ? (
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Detalhe</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index} className="border-t border-border hover:bg-surface-muted/50">
                  {result.columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        "px-3 py-2 text-strong",
                        numericTypes.has(column.type) || column.agg === "count"
                          ? "whitespace-nowrap text-right tabular-nums"
                          : "max-w-[28rem] truncate",
                      )}
                      title={typeof row[column.key] === "string" ? String(row[column.key]) : undefined}
                    >
                      {formatCell(entity, column, row[column.key] ?? null)}
                    </td>
                  ))}
                  {result.detailLabel ? (
                    <td className="px-3 py-2 text-right">
                      {row._href ? (
                        <Link
                          href={row._href}
                          className={cn(
                            "whitespace-nowrap text-xs font-semibold text-brand-dark underline-offset-2 hover:underline",
                            focusRing,
                          )}
                        >
                          {result.detailLabel}
                        </Link>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result.pageCount > 1 ? (
        <nav aria-label="Paginação do resultado" className="flex items-center justify-end gap-2 text-sm">
          <button
            type="button"
            disabled={pending || result.page <= 1}
            onClick={() => onPage(result.page - 1)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 font-medium text-strong disabled:opacity-40",
              focusRing,
            )}
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
            Anterior
          </button>
          <span className="text-medium">
            Página {result.page} de {result.pageCount}
          </span>
          <button
            type="button"
            disabled={pending || result.page >= result.pageCount}
            onClick={() => onPage(result.page + 1)}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-2.5 font-medium text-strong disabled:opacity-40",
              focusRing,
            )}
          >
            Próxima
            <ChevronRight aria-hidden="true" className="size-4" />
          </button>
        </nav>
      ) : null}
    </div>
  );
}
