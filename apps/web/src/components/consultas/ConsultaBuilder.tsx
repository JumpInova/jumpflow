"use client";

import { useMemo, useState, useTransition } from "react";
import { BookmarkPlus, FileSpreadsheet, FileText, Play, Plus, RotateCcw, X } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { executarConsulta } from "@/app/app/consultas/actions";
import {
  incompleteFilterMessage,
  initialSpec,
  measurableFields,
  pruneSpec,
  sortOptions,
} from "@/lib/consultas/builder";
import {
  AGGREGATION_LABELS,
  fieldAggregations,
  getField,
  GRANULARITY_LABELS,
} from "@/lib/consultas/catalog";
import { SPEC_LIMITS } from "@/lib/consultas/spec";
import type { ConsultaEntity, ConsultaSpec, Granularity } from "@/lib/consultas/types";
import type { ConsultaRunResult } from "@/lib/db/consultas";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";
import { ConsultaResultView } from "./ConsultaResultView";
import { controlClass, FilterEditor, iconButtonClass } from "./FilterEditor";
import { SaveViewDialog, type EditingView } from "./SaveViewDialog";

const EXPORT_ENDPOINT = "/api/consultas/exportar";

const EXPORT_ERRORS: Record<number, string> = {
  400: "Consulta inválida para exportação. Revise e execute de novo.",
  403: "Você não tem permissão para exportar esta consulta.",
  503: "Banco de dados indisponível neste ambiente.",
  504: "A exportação demorou demais. Adicione filtros e tente de novo.",
};

function filenameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  return /filename="([^"]+)"/.exec(header)?.[1] ?? fallback;
}

function Step({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
      <legend className="text-xs font-semibold uppercase tracking-wide text-soft">{title}</legend>
      {hint ? <p className="text-xs text-soft">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

export interface ConsultaBuilderProps {
  /** Catálogo JÁ filtrado pelo servidor (entidades e campos visíveis). */
  entities: ConsultaEntity[];
  canExport: boolean;
  demo: boolean;
  initial?: ConsultaSpec;
  /** `CONSULTAS_COMPARTILHAR` (o servidor revalida ao salvar). */
  canShare?: boolean;
  /** Visão do próprio usuário aberta para edição (`?visao=`). */
  editing?: EditingView;
}

/**
 * Construtor visual de Consultas (ESPECIFICAÇÃO §6 C1): entidade, filtros E/OU,
 * colunas ou agrupamento (≤ 2, com granularidade de data), medidas e
 * ordenação. Só monta a spec — o servidor valida, aplica escopo e executa.
 */
export function ConsultaBuilder({
  entities,
  canExport,
  demo,
  initial,
  canShare = false,
  editing,
}: ConsultaBuilderProps) {
  const firstEntity =
    entities.find((entity) => entity.key === initial?.entity) ?? entities[0];
  const [spec, setSpec] = useState<ConsultaSpec>(() =>
    initial ? pruneSpec(firstEntity, initial) : initialSpec(firstEntity),
  );
  const [result, setResult] = useState<ConsultaRunResult | null>(null);
  const [lastRun, setLastRun] = useState<ConsultaSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<"xlsx" | "csv" | null>(null);
  const [saving, setSaving] = useState(false);
  const [pending, startTransition] = useTransition();

  const entity = entities.find((e) => e.key === spec.entity) ?? firstEntity;
  const grouped = spec.groupBy.length > 0;
  const sortable = useMemo(() => sortOptions(entity, spec), [entity, spec]);
  const groupable = entity.fields.filter((field) => field.groupable);

  function update(next: ConsultaSpec) {
    setSpec(pruneSpec(entity, next));
  }

  function run(target: ConsultaSpec, page: number) {
    const incomplete = incompleteFilterMessage(entity, target);
    if (incomplete) {
      setError(incomplete);
      return;
    }
    setError(null);
    startTransition(async () => {
      const response = await executarConsulta(target, page);
      if (response.ok) {
        setResult(response.result);
        setLastRun(target);
      } else {
        setResult(null);
        setError(response.error);
      }
    });
  }

  async function exportAs(format: "xlsx" | "csv") {
    if (!lastRun || exporting) return;
    setExporting(format);
    setError(null);
    try {
      const response = await fetch(EXPORT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format, spec: lastRun }),
      });
      if (!response.ok) {
        setError(EXPORT_ERRORS[response.status] ?? "Não foi possível exportar. Tente novamente.");
        return;
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFrom(response, `consulta.${format}`);
      link.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Falha de conexão ao exportar. Tente novamente.");
    } finally {
      setExporting(null);
    }
  }

  const modeButton = (value: boolean, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={grouped === value}
      onClick={() => {
        if (value === grouped) return;
        if (value) {
          const firstGroup = groupable[0];
          const firstMeasure = measurableFields(entity)[0];
          update({
            ...spec,
            groupBy: firstGroup ? [{ field: firstGroup.key }] : [],
            measures:
              spec.measures.length > 0 || !firstMeasure
                ? spec.measures
                : [{ field: firstMeasure.key, agg: fieldAggregations(firstMeasure)[0] }],
          });
        } else {
          update({
            ...spec,
            groupBy: [],
            columns: spec.columns.length > 0 ? spec.columns : [...entity.defaultColumns],
          });
        }
      }}
      className={cn(
        "flex-1 rounded px-3 py-1.5 text-xs font-semibold",
        focusRing,
        grouped === value ? "bg-ink text-surface" : "text-medium hover:text-strong",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(320px,380px)_1fr]">
      <SectionPanel title="Construtor" description="Monte a consulta passo a passo.">
        <form
          className="space-y-4 p-4"
          onSubmit={(event) => {
            event.preventDefault();
            run(spec, 1);
          }}
        >
          <Step title="1. Entidade">
            <select
              aria-label="Entidade"
              className={controlClass}
              value={entity.key}
              onChange={(event) => {
                const next = entities.find((e) => e.key === event.target.value);
                if (!next) return;
                setSpec(initialSpec(next));
                setResult(null);
                setError(null);
              }}
            >
              {entities.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-soft">{entity.description}</p>
          </Step>

          <Step title="2. Filtros">
            <FilterEditor
              entity={entity}
              filters={spec.filters}
              onChange={(filters) => update({ ...spec, filters })}
            />
          </Step>

          <Step title="3. Formato do resultado">
            <div role="radiogroup" aria-label="Formato do resultado" className="flex rounded-md border border-border p-0.5">
              {modeButton(false, "Lista de registros")}
              {modeButton(true, "Agrupar e somar")}
            </div>
            {grouped ? (
              <div className="space-y-2">
                {spec.groupBy.map((group, index) => {
                  const field = getField(entity, group.field);
                  return (
                    <div key={index} className="grid grid-cols-[1fr_auto_auto] gap-1.5">
                      <select
                        aria-label={`Agrupar por (${index + 1})`}
                        className={controlClass}
                        value={group.field}
                        onChange={(event) =>
                          update({
                            ...spec,
                            groupBy: spec.groupBy.map((g, i) =>
                              i === index ? { field: event.target.value } : g,
                            ),
                          })
                        }
                      >
                        {groupable.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      {field?.type === "data" ? (
                        <select
                          aria-label={`Granularidade de ${field.label}`}
                          className={cn(controlClass, "w-24")}
                          value={group.granularity ?? "dia"}
                          onChange={(event) =>
                            update({
                              ...spec,
                              groupBy: spec.groupBy.map((g, i) =>
                                i === index
                                  ? { field: g.field, granularity: event.target.value as Granularity }
                                  : g,
                              ),
                            })
                          }
                        >
                          {Object.entries(GRANULARITY_LABELS).map(([key, text]) => (
                            <option key={key} value={key}>
                              {text}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        className={iconButtonClass}
                        aria-label={`Remover agrupamento ${index + 1}`}
                        onClick={() =>
                          update({ ...spec, groupBy: spec.groupBy.filter((_, i) => i !== index) })
                        }
                      >
                        <X aria-hidden="true" className="size-4" />
                      </button>
                    </div>
                  );
                })}
                {spec.groupBy.length < SPEC_LIMITS.groupBy ? (
                  <button
                    type="button"
                    onClick={() => {
                      const used = new Set(spec.groupBy.map((g) => g.field));
                      const next = groupable.find((f) => !used.has(f.key));
                      if (next) update({ ...spec, groupBy: [...spec.groupBy, { field: next.key }] });
                    }}
                    className={cn(
                      "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-xs font-semibold text-medium hover:text-strong",
                      focusRing,
                    )}
                  >
                    <Plus aria-hidden="true" className="size-3.5" />
                    Agrupar também por
                  </button>
                ) : null}
              </div>
            ) : (
              <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2.5">
                <legend className="sr-only">Colunas</legend>
                {entity.fields.map((field) => (
                  <label key={field.key} className="flex items-center gap-2 text-sm text-medium">
                    <input
                      type="checkbox"
                      checked={spec.columns.includes(field.key)}
                      onChange={(event) =>
                        update({
                          ...spec,
                          columns: event.target.checked
                            ? [...spec.columns, field.key]
                            : spec.columns.filter((key) => key !== field.key),
                        })
                      }
                    />
                    {field.label}
                  </label>
                ))}
              </fieldset>
            )}
          </Step>

          <Step
            title="4. Medidas"
            hint={grouped ? "Calculadas por grupo e no total geral." : "Viram uma linha de totais sobre todos os registros filtrados."}
          >
            {spec.measures.map((measure, index) => {
              const field = getField(entity, measure.field);
              return (
                <div key={index} className="grid grid-cols-[auto_1fr_auto] gap-1.5">
                  <select
                    aria-label={`Medida ${index + 1}: agregação`}
                    className={cn(controlClass, "w-28")}
                    value={measure.agg}
                    onChange={(event) =>
                      update({
                        ...spec,
                        measures: spec.measures.map((m, i) =>
                          i === index ? { ...m, agg: event.target.value as typeof m.agg } : m,
                        ),
                      })
                    }
                  >
                    {(field ? fieldAggregations(field) : ["count" as const]).map((agg) => (
                      <option key={agg} value={agg}>
                        {AGGREGATION_LABELS[agg]}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`Medida ${index + 1}: campo`}
                    className={controlClass}
                    value={measure.field}
                    onChange={(event) => {
                      const next = getField(entity, event.target.value);
                      if (!next) return;
                      const aggs = fieldAggregations(next);
                      update({
                        ...spec,
                        measures: spec.measures.map((m, i) =>
                          i === index
                            ? { field: next.key, agg: aggs.includes(m.agg) ? m.agg : aggs[0] }
                            : m,
                        ),
                      });
                    }}
                  >
                    {measurableFields(entity).map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={iconButtonClass}
                    aria-label={`Remover medida ${index + 1}`}
                    onClick={() =>
                      update({ ...spec, measures: spec.measures.filter((_, i) => i !== index) })
                    }
                  >
                    <X aria-hidden="true" className="size-4" />
                  </button>
                </div>
              );
            })}
            {spec.measures.length < SPEC_LIMITS.measures ? (
              <button
                type="button"
                onClick={() => {
                  const field = measurableFields(entity)[0];
                  if (field) {
                    update({
                      ...spec,
                      measures: [...spec.measures, { field: field.key, agg: fieldAggregations(field)[0] }],
                    });
                  }
                }}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-xs font-semibold text-medium hover:text-strong",
                  focusRing,
                )}
              >
                <Plus aria-hidden="true" className="size-3.5" />
                Adicionar medida
              </button>
            ) : null}
          </Step>

          <Step title="5. Ordenação">
            {spec.sort.map((item, index) => (
              <div key={index} className="grid grid-cols-[1fr_auto_auto] gap-1.5">
                <select
                  aria-label={`Ordenar por (${index + 1})`}
                  className={controlClass}
                  value={item.key}
                  onChange={(event) =>
                    update({
                      ...spec,
                      sort: spec.sort.map((s, i) => (i === index ? { ...s, key: event.target.value } : s)),
                    })
                  }
                >
                  {sortable.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Direção da ordenação ${index + 1}`}
                  className={cn(controlClass, "w-28")}
                  value={item.dir}
                  onChange={(event) =>
                    update({
                      ...spec,
                      sort: spec.sort.map((s, i) =>
                        i === index ? { ...s, dir: event.target.value as "asc" | "desc" } : s,
                      ),
                    })
                  }
                >
                  <option value="asc">Crescente</option>
                  <option value="desc">Decrescente</option>
                </select>
                <button
                  type="button"
                  className={iconButtonClass}
                  aria-label={`Remover ordenação ${index + 1}`}
                  onClick={() => update({ ...spec, sort: spec.sort.filter((_, i) => i !== index) })}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </div>
            ))}
            {spec.sort.length < SPEC_LIMITS.sort && sortable.length > 0 ? (
              <button
                type="button"
                onClick={() => update({ ...spec, sort: [...spec.sort, { key: sortable[0].key, dir: "asc" }] })}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-xs font-semibold text-medium hover:text-strong",
                  focusRing,
                )}
              >
                <Plus aria-hidden="true" className="size-3.5" />
                Adicionar ordenação
              </button>
            ) : null}
          </Step>

          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <ActionButton type="submit" icon={Play} disabled={pending || demo}>
              {pending ? "Executando…" : "Executar"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              icon={BookmarkPlus}
              disabled={demo}
              onClick={() => {
                const incomplete = incompleteFilterMessage(entity, spec);
                if (incomplete) {
                  setError(incomplete);
                  return;
                }
                setSaving(true);
              }}
            >
              {editing ? "Salvar visão…" : "Salvar como visão"}
            </ActionButton>
            <ActionButton
              type="button"
              variant="secondary"
              icon={RotateCcw}
              onClick={() => {
                setSpec(initialSpec(entity));
                setResult(null);
                setError(null);
              }}
            >
              Limpar
            </ActionButton>
          </div>
          {demo ? (
            <p className="text-xs text-soft">
              Ambiente de demonstração: sem banco de dados, a consulta não é executada.
            </p>
          ) : null}
        </form>
      </SectionPanel>

      {saving ? (
        <SaveViewDialog
          open={saving}
          onClose={() => setSaving(false)}
          spec={spec}
          canShare={canShare}
          editing={editing}
        />
      ) : null}

      <SectionPanel
        title="Resultado"
        action={
          canExport && result && lastRun ? (
            <div className="flex gap-2">
              <ActionButton
                size="sm"
                variant="secondary"
                icon={FileSpreadsheet}
                disabled={exporting !== null}
                onClick={() => exportAs("xlsx")}
              >
                {exporting === "xlsx" ? "Gerando…" : "Excel"}
              </ActionButton>
              <ActionButton
                size="sm"
                variant="secondary"
                icon={FileText}
                disabled={exporting !== null}
                onClick={() => exportAs("csv")}
              >
                {exporting === "csv" ? "Gerando…" : "CSV"}
              </ActionButton>
            </div>
          ) : null
        }
      >
        <div className="p-4">
          <ConsultaResultView
            entity={entities.find((e) => e.key === result?.entity) ?? entity}
            result={result}
            error={error}
            pending={pending}
            onPage={(page) => {
              if (lastRun) run(lastRun, page);
            }}
          />
        </div>
      </SectionPanel>
    </div>
  );
}
