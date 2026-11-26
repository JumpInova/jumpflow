/**
 * Datas relativas da spec (âncoras de `RELATIVE_ANCHORS` + `offsetDays`),
 * resolvidas no fuso America/Sao_Paulo via o util de data do projeto — nunca
 * UTC−3 fixo (ESPECIFICAÇÃO §5 / §9).
 */
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";
import type { RelativeDate } from "./types";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `yyyy-mm-dd` válido no calendário (rejeita 2026-02-30). */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** Dia-âncora (sem offset) no calendário de São Paulo de `today`. */
function anchorDate(anchor: RelativeDate["relative"], today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  switch (anchor) {
    case "hoje":
      return today;
    case "inicio_semana": {
      // Semana começa na segunda (ISO), como `date_trunc('week')` no Postgres.
      const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
      return addDays(today, -((weekday + 6) % 7));
    }
    case "inicio_mes":
      return `${today.slice(0, 8)}01`;
    case "fim_mes":
      return lastDayOfMonth(y, m);
    case "inicio_mes_anterior":
      return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
    case "fim_mes_anterior":
      return addDays(`${today.slice(0, 8)}01`, -1);
    case "inicio_proximo_mes":
      return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    case "fim_proximo_mes":
      return m === 12 ? lastDayOfMonth(y + 1, 1) : lastDayOfMonth(y, m + 1);
    case "inicio_ano":
      return `${y}-01-01`;
    case "inicio_ano_anterior":
      return `${y - 1}-01-01`;
    case "fim_ano_anterior":
      return `${y - 1}-12-31`;
  }
}

/** Resolve uma data relativa para `yyyy-mm-dd` no dia de São Paulo de `now`. */
export function resolveRelativeDate(value: RelativeDate, now: Date): string {
  return addDays(anchorDate(value.relative, isoDateInSaoPaulo(now)), value.offsetDays ?? 0);
}

export function isRelativeDate(value: unknown): value is RelativeDate {
  return (
    typeof value === "object" &&
    value !== null &&
    "relative" in value &&
    typeof (value as { relative: unknown }).relative === "string"
  );
}

export const RELATIVE_DATE_LABELS: Record<RelativeDate["relative"], string> = {
  hoje: "Hoje",
  inicio_semana: "Início da semana",
  inicio_mes: "Início do mês",
  fim_mes: "Fim do mês",
  inicio_mes_anterior: "Início do mês anterior",
  fim_mes_anterior: "Fim do mês anterior",
  inicio_proximo_mes: "Início do próximo mês",
  fim_proximo_mes: "Fim do próximo mês",
  inicio_ano: "Início do ano",
  inicio_ano_anterior: "Início do ano anterior",
  fim_ano_anterior: "Fim do ano anterior",
};
