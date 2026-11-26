/**
 * Formatação de células do resultado (tela e exportação). Puro: listas viram o
 * rótulo PT-BR do catálogo, booleanos viram Sim/Não, datas `dd/mm/aaaa`.
 */
import { getField, optionLabel } from "./catalog";
import type { OutputColumn } from "./compile";
import type { CellValue, ResultRow } from "./result";
import type { ConsultaEntity } from "./types";

type ColumnMeta = Pick<OutputColumn, "key" | "type" | "kind" | "field" | "agg" | "granularity">;

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const NUMBER = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/** `aaaa-mm-dd` → `dd/mm/aaaa`; com granularidade mês/ano, `mm/aaaa`/`aaaa`. */
export function formatIsoDate(iso: string, granularity?: OutputColumn["granularity"]): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  if (granularity === "ano") return y;
  if (granularity === "mes") return `${m}/${y}`;
  return `${d}/${m}/${y}`;
}

/** Texto exibido numa célula (tela). */
export function formatCell(
  entity: ConsultaEntity,
  column: ColumnMeta,
  value: CellValue,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (column.kind === "measure" && column.agg === "count") {
    return NUMBER.format(Number(value));
  }
  switch (column.type) {
    case "moeda":
      return BRL.format(Number(value));
    case "horas":
      return `${NUMBER.format(Number(value))} h`;
    case "numero":
      return NUMBER.format(Number(value));
    case "booleano":
      return value === true ? "Sim" : "Não";
    case "data":
      return typeof value === "string"
        ? formatIsoDate(value, column.granularity)
        : String(value);
    case "lista": {
      const field = getField(entity, column.field);
      return field ? optionLabel(field, value) : String(value);
    }
    default:
      return String(value);
  }
}

/** Valor para exportação: números ficam números; o resto vira texto legível. */
export function exportCell(
  entity: ConsultaEntity,
  column: ColumnMeta,
  row: ResultRow,
): string | number | null {
  const value = row[column.key] ?? null;
  if (value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (column.type === "data" && typeof value === "string") {
    return formatIsoDate(value, column.granularity);
  }
  if (column.type === "lista") {
    const field = getField(entity, column.field);
    return field ? optionLabel(field, value) : String(value);
  }
  return String(value);
}

/** Formato numérico do Excel por tipo. */
export function excelNumFmt(column: ColumnMeta): string | undefined {
  if (column.kind === "measure" && column.agg === "count") return "0";
  if (column.type === "moeda") return "#,##0.00";
  if (column.type === "horas" || column.type === "numero") return "#,##0.##";
  return undefined;
}
