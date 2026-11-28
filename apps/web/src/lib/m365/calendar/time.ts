/**
 * Datas/horários da agenda no fuso operacional (America/Sao_Paulo). PURO.
 * A agenda chega em UTC; o lançamento de horas usa data-calendário (meia-noite
 * UTC, convenção de TimeEntry.date) e relógio HH:mm local.
 */
export const M365_TIME_ZONE = "America/Sao_Paulo";

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** yyyy-mm-dd local. */
export function localIsoDate(date: Date, timeZone = M365_TIME_ZONE): string {
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Data-calendário local gravada à meia-noite UTC (TimeEntry.date). */
export function localDateAsUtcMidnight(date: Date, timeZone = M365_TIME_ZONE): Date {
  return new Date(`${localIsoDate(date, timeZone)}T00:00:00.000Z`);
}

/** HH:mm local. */
export function localClock(date: Date, timeZone = M365_TIME_ZONE): string {
  const p = parts(date, timeZone);
  return `${p.hour}:${p.minute}`;
}
