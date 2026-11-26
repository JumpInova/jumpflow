"use client";

import { useId } from "react";
import { BarChart3 } from "lucide-react";
import {
  buildChartData,
  chartAvailability,
  niceMax,
  pieArcs,
  type ChartData,
  type ChartSeries,
  type ChartSource,
} from "@/lib/consultas/chart";
import { formatCell } from "@/lib/consultas/format";
import type { Visualization } from "@/lib/consultas/saved";
import type { ConsultaEntity } from "@/lib/consultas/types";
import { cn } from "@/lib/utils";

/**
 * Gráficos de Consultas em SVG puro (o projeto não tem lib de gráficos — o
 * mesmo padrão de RadarChart/AvailabilityHeatmap). Cores de PREENCHIMENTO
 * vêm dos acentos do design system (azul ação, flow, cyan, lilás, marker);
 * textos usam os tons de texto (AA). Sem animação: leitura operacional.
 */

const SERIES_COLORS = ["var(--brand)", "var(--flow)", "var(--accent)"];
const PIE_COLORS = [
  "var(--brand)",
  "var(--flow)",
  "var(--marker)",
  "var(--cyan)",
  "var(--accent)",
  "var(--ops-accent)",
  "var(--brand-dark)",
  "var(--success)",
  "var(--soft)",
];

const COMPACT = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });

function valueText(entity: ConsultaEntity, series: ChartSeries, value: number): string {
  return formatCell(entity, series.column, value);
}

function Legend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-medium" aria-hidden="true">
      {series.map((item, index) => (
        <li key={item.key} className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-ink/40" style={{ background: SERIES_COLORS[index] }} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Tabela acessível equivalente ao gráfico (leitores de tela). */
function DataTableFallback({ entity, data, caption }: { entity: ConsultaEntity; data: ChartData; caption: string }) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Grupo</th>
          {data.series.map((series) => (
            <th key={series.key} scope="col">{series.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {data.categories.map((category, row) => (
          <tr key={`${category}-${row}`}>
            <th scope="row">{category}</th>
            {data.series.map((series) => (
              <td key={series.key}>{valueText(entity, series, series.values[row])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function domain(data: ChartData): { min: number; max: number } {
  const values = data.series.flatMap((series) => series.values);
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  return { max: niceMax(rawMax), min: rawMin < 0 ? -niceMax(-rawMin) : 0 };
}

function BarChart({ entity, data, compact }: { entity: ConsultaEntity; data: ChartData; compact: boolean }) {
  const { min, max } = domain(data);
  const span = max - min || 1;
  const rowHeight = compact ? 22 : 28;
  const barGap = 4;
  const seriesCount = data.series.length;
  const labelWidth = compact ? 110 : 170;
  const width = 640;
  const plotWidth = width - labelWidth - 72;
  const height = data.categories.length * rowHeight + 24;
  const zeroX = labelWidth + ((0 - min) / span) * plotWidth;
  const barHeight = (rowHeight - barGap * 2) / seriesCount;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" aria-hidden="true">
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const x = labelWidth + tick * plotWidth;
        return (
          <g key={tick}>
            <line x1={x} x2={x} y1={0} y2={height - 20} stroke="var(--border)" strokeWidth={1} />
            <text x={x} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--soft)">
              {COMPACT.format(min + tick * span)}
            </text>
          </g>
        );
      })}
      {data.categories.map((category, row) => {
        const y = row * rowHeight;
        return (
          <g key={`${category}-${row}`}>
            <text
              x={labelWidth - 8}
              y={y + rowHeight / 2 + 4}
              textAnchor="end"
              fontSize={11}
              fill="var(--medium)"
            >
              {category.length > (compact ? 16 : 26) ? `${category.slice(0, compact ? 15 : 25)}…` : category}
            </text>
            {data.series.map((series, index) => {
              const value = series.values[row];
              const x = labelWidth + ((Math.min(value, 0) - min) / span) * plotWidth;
              const w = (Math.abs(value) / span) * plotWidth;
              const barY = y + barGap + index * barHeight;
              return (
                <g key={series.key}>
                  <rect
                    x={x}
                    y={barY}
                    width={Math.max(w, value === 0 ? 0 : 1)}
                    height={Math.max(barHeight - 1, 2)}
                    rx={2}
                    fill={SERIES_COLORS[index]}
                    stroke="var(--ink)"
                    strokeWidth={0.75}
                  >
                    <title>{`${category} — ${series.label}: ${valueText(entity, series, value)}`}</title>
                  </rect>
                  {seriesCount === 1 && !compact ? (
                    <text
                      x={value < 0 ? x - 4 : x + w + 4}
                      y={barY + barHeight / 2 + 3}
                      textAnchor={value < 0 ? "end" : "start"}
                      fontSize={10}
                      fill="var(--strong)"
                    >
                      {COMPACT.format(value)}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
      <line x1={zeroX} x2={zeroX} y1={0} y2={height - 20} stroke="var(--ink)" strokeWidth={1} />
    </svg>
  );
}

function LineChart({ entity, data, compact }: { entity: ConsultaEntity; data: ChartData; compact: boolean }) {
  const { min, max } = domain(data);
  const span = max - min || 1;
  const width = 640;
  const height = compact ? 200 : 280;
  const left = 48;
  const bottom = 40;
  const plotWidth = width - left - 16;
  const plotHeight = height - bottom - 12;
  const count = data.categories.length;
  const xAt = (index: number) => left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const yAt = (value: number) => 12 + plotHeight - ((value - min) / span) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil(count / (compact ? 6 : 10)));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" aria-hidden="true">
      {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
        const value = min + tick * span;
        const y = yAt(value);
        return (
          <g key={tick}>
            <line x1={left} x2={width - 16} y1={y} y2={y} stroke="var(--border)" strokeWidth={1} />
            <text x={left - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--soft)">
              {COMPACT.format(value)}
            </text>
          </g>
        );
      })}
      {data.categories.map((category, index) =>
        index % labelEvery === 0 ? (
          <text
            key={`${category}-${index}`}
            x={xAt(index)}
            y={height - bottom + 16}
            textAnchor="middle"
            fontSize={10}
            fill="var(--medium)"
          >
            {category.length > 12 ? `${category.slice(0, 11)}…` : category}
          </text>
        ) : null,
      )}
      {data.series.map((series, seriesIndex) => {
        const points = series.values.map((value, index) => `${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`);
        return (
          <g key={series.key}>
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke={SERIES_COLORS[seriesIndex]}
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
            {series.values.map((value, index) => (
              <circle
                key={index}
                cx={xAt(index)}
                cy={yAt(value)}
                r={3.5}
                fill="var(--surface)"
                stroke={SERIES_COLORS[seriesIndex]}
                strokeWidth={2}
              >
                <title>{`${data.categories[index]} — ${series.label}: ${valueText(entity, series, value)}`}</title>
              </circle>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function PieChart({ entity, data, compact }: { entity: ConsultaEntity; data: ChartData; compact: boolean }) {
  const series = data.series[0];
  const size = 200;
  const center = size / 2;
  const arcs = pieArcs(data.categories, series.values, center, 86, 48).map((arc, index) => ({
    ...arc,
    d: arc.path,
    color: PIE_COLORS[index % PIE_COLORS.length],
  }));

  return (
    <div className={cn("flex flex-col items-center gap-4", !compact && "sm:flex-row sm:items-start")}>
      <svg viewBox={`0 0 ${size} ${size}`} className={cn("h-auto shrink-0", compact ? "w-40" : "w-52")} aria-hidden="true">
        {arcs.map((arc, index) =>
          arc.fraction > 0 ? (
            <path key={index} d={arc.d} fill={arc.color} stroke="var(--ink)" strokeWidth={1} fillRule="evenodd">
              <title>{`${arc.label}: ${valueText(entity, series, arc.value)}`}</title>
            </path>
          ) : null,
        )}
      </svg>
      <ul className="w-full min-w-0 space-y-1 text-xs" aria-hidden="true">
        {arcs.map((arc, index) => (
          <li key={index} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-sm border border-ink/40" style={{ background: arc.color }} />
            <span className="min-w-0 flex-1 truncate text-medium" title={arc.label}>{arc.label}</span>
            <span className="tabular-nums text-strong">{valueText(entity, series, arc.value)}</span>
            <span className="w-10 text-right tabular-nums text-soft">{Math.round(arc.fraction * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Indicator({ entity, source, compact }: { entity: ConsultaEntity; source: ChartSource; compact: boolean }) {
  return (
    <dl className={cn("grid gap-3", source.measures.length > 1 && !compact ? "sm:grid-cols-2" : null)}>
      {source.measures.map((measure) => (
        <div
          key={measure.key}
          className="rounded-md border-2 border-ink bg-surface px-4 py-3 shadow-[3px_3px_0_0_var(--color-ink)]"
        >
          <dt className="text-xs font-semibold uppercase tracking-wide text-soft">{measure.label}</dt>
          <dd className={cn("mt-1 font-semibold tabular-nums text-strong", compact ? "text-2xl" : "text-3xl")}>
            {formatCell(entity, measure, source.totals?.[measure.key] ?? null)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface ConsultaChartProps {
  entity: ConsultaEntity;
  source: ChartSource;
  visualization: Exclude<Visualization, "TABLE">;
  title: string;
  compact?: boolean;
}

/** Gráfico (barras, linhas, pizza) ou indicador do resultado de uma visão. */
export function ConsultaChart({ entity, source, visualization, title, compact = false }: ConsultaChartProps) {
  const captionId = useId();
  const availability = chartAvailability(source, visualization);
  if (!availability.ok) {
    return (
      <p className="flex items-start gap-2 rounded-md border border-dashed border-border bg-surface px-3 py-3 text-sm text-medium">
        <BarChart3 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-soft" />
        {availability.reason}
      </p>
    );
  }
  if (visualization === "INDICATOR") {
    return <Indicator entity={entity} source={source} compact={compact} />;
  }
  const data = buildChartData(entity, source, visualization);
  const caption = `${title}: gráfico de ${visualization === "BAR" ? "barras" : visualization === "LINE" ? "linhas" : "pizza"}`;
  return (
    <figure className="space-y-2" aria-labelledby={captionId}>
      <figcaption id={captionId} className="sr-only">{caption}</figcaption>
      {visualization === "BAR" ? <BarChart entity={entity} data={data} compact={compact} /> : null}
      {visualization === "LINE" ? <LineChart entity={entity} data={data} compact={compact} /> : null}
      {visualization === "PIE" ? <PieChart entity={entity} data={data} compact={compact} /> : null}
      {visualization !== "PIE" ? <Legend series={data.series} /> : null}
      {data.omitted > 0 ? (
        <p className="text-xs text-soft">
          O gráfico mostra os primeiros {data.categories.length} grupos; {data.omitted} ficaram de fora
          {compact ? " (abra a visão para ver todos ou exporte)." : " (veja a tabela abaixo ou exporte)."}
        </p>
      ) : null}
      <DataTableFallback entity={entity} data={data} caption={caption} />
    </figure>
  );
}
