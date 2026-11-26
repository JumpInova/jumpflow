"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, SearchX, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import {
  AGGREGATION_LABELS,
  FIELD_TYPE_LABELS,
  SENSITIVITY_LABELS,
} from "@/lib/consultas/catalog";
import type { ConsultaEntity, ConsultaField } from "@/lib/consultas/types";
import { focusRing, focusRingInput } from "@/lib/styles";
import { cn } from "@/lib/utils";

const SENSITIVITY_TONE: Record<ConsultaField["sensitivity"], StatusTone> = {
  publico: "neutral",
  financeiro: "warning",
  custo_sensivel: "danger",
};

/** Normaliza para busca sem acento/caixa. */
function norm(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function fieldMatches(field: ConsultaField, query: string): boolean {
  return [field.label, field.key, field.description, field.source, field.owner ?? ""]
    .map(norm)
    .some((text) => text.includes(query));
}

export interface CatalogBrowserProps {
  /** Catálogo JÁ filtrado pelo servidor para o usuário. */
  entities: ConsultaEntity[];
  canCreate: boolean;
}

/**
 * Navegador do catálogo: busca por entidade/campo, descrição de negócio,
 * origem, tipo, sensibilidade (badge), métricas oficiais e exemplos. "Usar na
 * consulta" abre o construtor já com o campo ou o exemplo.
 */
export function CatalogBrowser({ entities, canCreate }: CatalogBrowserProps) {
  const [query, setQuery] = useState("");
  const q = norm(query.trim());

  const filtered = useMemo(
    () =>
      entities
        .map((entity) => {
          const entityHit =
            q === "" || norm(`${entity.label} ${entity.description}`).includes(q);
          const fields = entityHit
            ? entity.fields
            : entity.fields.filter((field) => fieldMatches(field, q));
          return { entity, fields };
        })
        .filter(({ fields }) => fields.length > 0),
    [entities, q],
  );

  return (
    <div className="space-y-6">
      <label className="relative block max-w-xl">
        <span className="sr-only">Buscar no catálogo</span>
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-soft"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar entidade ou campo (ex.: receita, área, aprovadas)"
          className={cn(
            "h-10 w-full rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-strong",
            focusRingInput,
          )}
        />
      </label>

      {filtered.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Nada encontrado"
          description="Nenhuma entidade ou campo corresponde à busca."
        />
      ) : null}

      {filtered.map(({ entity, fields }) => (
        <section
          key={entity.key}
          aria-labelledby={`entidade-${entity.key}`}
          className="rounded-[var(--radius-card)] border-2 border-ink bg-surface shadow-[4px_4px_0_0_var(--color-ink)]"
        >
          <header className="flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2
                id={`entidade-${entity.key}`}
                className="text-lg font-semibold text-strong"
              >
                {entity.label}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-medium">
                {entity.description}
              </p>
            </div>
            {canCreate ? (
              <Link
                href={`/app/consultas?entidade=${entity.key}`}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center rounded-md border border-border bg-surface px-3 text-xs font-semibold text-strong hover:bg-surface-muted",
                  focusRing,
                )}
              >
                Consultar {entity.label}
              </Link>
            ) : null}
          </header>

          {entity.metrics && entity.metrics.length > 0 ? (
            <div className="border-b border-border px-5 py-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-soft">
                Métricas oficiais
              </h3>
              <dl className="mt-2 grid gap-3 md:grid-cols-2">
                {entity.metrics.map((metric) => (
                  <div key={metric.label} className="text-sm">
                    <dt className="font-semibold text-strong">{metric.label}</dt>
                    <dd className="mt-0.5 font-mono text-xs text-medium">
                      {metric.formula}
                    </dd>
                    <dd className="mt-0.5 text-medium">{metric.description}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <caption className="sr-only">Campos de {entity.label}</caption>
              <thead className="bg-surface-muted text-xs uppercase tracking-wide text-soft">
                <tr>
                  <th scope="col" className="px-5 py-2 font-semibold">Campo</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Significado</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Tipo</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Sensibilidade</th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => (
                  <tr key={field.key} className="border-t border-border align-top">
                    <td className="px-5 py-3">
                      <p className="font-semibold text-strong">{field.label}</p>
                      <p className="mt-0.5 font-mono text-xs text-soft">{field.key}</p>
                    </td>
                    <td className="px-3 py-3 text-medium">
                      <p>{field.description}</p>
                      <p className="mt-1 text-xs text-soft">
                        Origem: <span className="font-mono">{field.source}</span>
                        {field.owner ? ` · Dono: ${field.owner}` : null}
                      </p>
                      {field.example ? (
                        <p className="mt-0.5 text-xs text-soft">Exemplo: {field.example}</p>
                      ) : null}
                      {field.options && field.options.length > 0 ? (
                        <p className="mt-0.5 text-xs text-soft">
                          Valores: {field.options.map((option) => option.label).join(", ")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3 text-medium">
                      <p>{FIELD_TYPE_LABELS[field.type]}</p>
                      {field.aggregations && field.aggregations.length > 0 ? (
                        <p className="mt-0.5 text-xs text-soft">
                          {field.aggregations.map((agg) => AGGREGATION_LABELS[agg]).join(", ")}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge tone={SENSITIVITY_TONE[field.sensitivity]}>
                        {SENSITIVITY_LABELS[field.sensitivity]}
                      </StatusBadge>
                    </td>
                    <td className="px-3 py-3 text-right">
                      {canCreate ? (
                        <Link
                          href={`/app/consultas?entidade=${entity.key}&campo=${field.key}`}
                          className={cn(
                            "whitespace-nowrap text-xs font-semibold text-brand-dark underline-offset-2 hover:underline",
                            focusRing,
                          )}
                        >
                          Usar na consulta
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {entity.examples.length > 0 ? (
            <div className="border-t border-border px-5 py-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-soft">
                Exemplos
              </h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {entity.examples.map((example, index) => (
                  <li key={example.label}>
                    {canCreate ? (
                      <Link
                        href={`/app/consultas?entidade=${entity.key}&exemplo=${index}`}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-strong hover:bg-surface-muted",
                          focusRing,
                        )}
                      >
                        <Sparkles aria-hidden="true" className="size-3.5 text-brand" />
                        {example.label}
                      </Link>
                    ) : (
                      <span className="inline-flex rounded-md border border-border px-3 py-1.5 text-xs text-medium">
                        {example.label}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
