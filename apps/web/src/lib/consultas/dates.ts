/**
 * Datas relativas da spec (`hoje`, `inicio_mes`, `inicio_semana` + offset),
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

/** Resolve uma data relativa para `yyyy-mm-dd` no dia de São Paulo de `now`. */
export function resolveRelativeDate(value: RelativeDate, now: Date): string {
  const today = isoDateInSaoPaulo(now);
  let base = today;
  if (value.relative === "inicio_mes") {
    base = `${today.slice(0, 8)}01`;
  } else if (value.relative === "inicio_semana") {
    // Semana começa na segunda (ISO), como `date_trunc('week')` no Postgres.
    const [y, m, d] = today.split("-").map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
    base = addDays(today, -((weekday + 6) % 7));
  }
  return addDays(base, value.offsetDays ?? 0);
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
  inicio_mes: "Início do mês",
  inicio_semana: "Início da semana",
};
