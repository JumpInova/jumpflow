"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { executarVisao } from "@/app/app/consultas/visoes/actions";
import type { Visualization } from "@/lib/consultas/saved";
import type { ConsultaEntity } from "@/lib/consultas/types";
import type { ConsultaRunResult } from "@/lib/db/consultas";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { ConsultaChart } from "./ConsultaChart";
import { ConsultaResultView } from "./ConsultaResultView";

export interface SavedViewRunnerProps {
  viewId: string;
  name: string;
  /** Entidade do catálogo JÁ filtrado para quem vê. */
  entity: ConsultaEntity;
  visualization: Visualization;
  /** Cartão de painel: só o gráfico/indicador (ou tabela resumida). */
  compact?: boolean;
  demo?: boolean;
}

const CARD_TABLE_ROWS = 8;

/**
 * Executa uma visão salva pelo id (a spec nunca passa pelo cliente: o
 * servidor a carrega e roda com a permissão de quem vê) e mostra o gráfico
 * escolhido e/ou a tabela.
 */
export function SavedViewRunner({ viewId, name, entity, visualization, compact = false, demo = false }: SavedViewRunnerProps) {
  const [result, setResult] = useState<ConsultaRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const load = useCallback(
    (page: number) => {
      if (demo) return;
      startTransition(async () => {
        const response = await executarVisao(viewId, page);
        if (response.ok) {
          setResult(response.data);
          setError(null);
        } else {
          setError(response.error);
        }
      });
    },
    [viewId, demo],
  );

  useEffect(() => {
    load(1);
  }, [load]);

  if (demo) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-medium">
        Ambiente de demonstração: sem banco de dados, a visão não é executada.
      </p>
    );
  }

  if (error && !result) {
    return (
      <div role="alert" className="flex flex-wrap items-start gap-3 rounded-md border-2 border-danger bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <p className="flex-1">{error}</p>
        <button
          type="button"
          onClick={() => load(1)}
          className={cn("inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline", focusRing)}
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Tentar de novo
        </button>
      </div>
    );
  }

  if (!result) {
    return (
      <div aria-busy="true" aria-live="polite" className="space-y-2">
        <span className="sr-only">Carregando a visão…</span>
        <div className="h-4 w-1/3 animate-pulse rounded bg-surface-muted motion-reduce:animate-none" />
        <div className={cn("animate-pulse rounded bg-surface-muted motion-reduce:animate-none", compact ? "h-32" : "h-56")} />
      </div>
    );
  }

  const chart =
    visualization !== "TABLE" ? (
      <ConsultaChart entity={entity} source={result} visualization={visualization} title={name} compact={compact} />
    ) : null;

  if (compact) {
    if (chart) return <div className={cn(pending && "opacity-60")}>{chart}</div>;
    const preview: ConsultaRunResult = {
      ...result,
      rows: result.rows.slice(0, CARD_TABLE_ROWS),
      pageCount: 1,
    };
    return (
      <div className="space-y-2">
        <ConsultaResultView entity={entity} result={preview} error={null} pending={pending} onPage={() => undefined} />
        {result.rows.length > CARD_TABLE_ROWS || result.totalRows > CARD_TABLE_ROWS ? (
          <p className="text-xs text-soft">Mostrando {CARD_TABLE_ROWS} de {result.totalRows} — abra a visão para ver tudo.</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {chart}
      <ConsultaResultView entity={entity} result={result} error={error} pending={pending} onPage={load} />
    </div>
  );
}
