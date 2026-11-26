"use client";

import { Plus, X } from "lucide-react";
import { changeOperator, newCondition } from "@/lib/consultas/builder";
import { getField } from "@/lib/consultas/catalog";
import { isRelativeDate, RELATIVE_DATE_LABELS } from "@/lib/consultas/dates";
import { OP_LABELS, OPS_BY_TYPE, SPEC_LIMITS } from "@/lib/consultas/spec";
import type {
  Condition,
  ConsultaEntity,
  ConsultaField,
  ConsultaSpec,
  RelativeDate,
  Value,
} from "@/lib/consultas/types";
import { focusRing, focusRingInput } from "@/lib/styles";
import { cn } from "@/lib/utils";

export const controlClass = cn(
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-strong",
  focusRingInput,
);

export const iconButtonClass = cn(
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-medium hover:bg-surface-muted hover:text-strong",
  focusRing,
);

type Filters = ConsultaSpec["filters"];

function ScalarInput({
  field,
  value,
  onChange,
  label,
}: {
  field: ConsultaField;
  value: Value | undefined;
  onChange: (value: Value) => void;
  label: string;
}) {
  if (field.type === "lista") {
    return (
      <select
        aria-label={label}
        className={controlClass}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "booleano") {
    return (
      <select
        aria-label={label}
        className={controlClass}
        value={value === false ? "false" : "true"}
        onChange={(event) => onChange(event.target.value === "true")}
      >
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </select>
    );
  }
  if (field.type === "data") {
    const relative = isRelativeDate(value) ? value : null;
    const mode = relative ? relative.relative : "fixa";
    return (
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <select
          aria-label={`${label}: tipo de data`}
          className={controlClass}
          value={mode}
          onChange={(event) => {
            const next = event.target.value;
            if (next === "fixa") onChange("");
            else onChange({ relative: next as RelativeDate["relative"] });
          }}
        >
          <option value="fixa">Data fixa</option>
          {Object.entries(RELATIVE_DATE_LABELS).map(([key, text]) => (
            <option key={key} value={key}>
              {text}
            </option>
          ))}
        </select>
        {relative ? (
          <input
            type="number"
            aria-label={`${label}: deslocamento em dias`}
            title="Deslocamento em dias (ex.: -30)"
            className={cn(controlClass, "w-20")}
            value={relative.offsetDays ?? 0}
            onChange={(event) => {
              const days = Math.trunc(Number(event.target.value) || 0);
              onChange(days === 0 ? { relative: relative.relative } : { relative: relative.relative, offsetDays: days });
            }}
          />
        ) : (
          <input
            type="date"
            aria-label={label}
            className={cn(controlClass, "w-36")}
            value={typeof value === "string" ? value : ""}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </div>
    );
  }
  if (field.type === "numero" || field.type === "moeda" || field.type === "horas") {
    return (
      <input
        type="number"
        step="any"
        aria-label={label}
        className={controlClass}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))
        }
      />
    );
  }
  return (
    <input
      type="text"
      aria-label={label}
      maxLength={SPEC_LIMITS.stringLength}
      className={controlClass}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function ListInput({
  field,
  values,
  onChange,
  label,
}: {
  field: ConsultaField;
  values: Value[];
  onChange: (values: Value[]) => void;
  label: string;
}) {
  if (field.type === "lista") {
    const selected = new Set(values.map(String));
    return (
      <fieldset className="flex flex-wrap gap-x-3 gap-y-1 rounded-md border border-border px-2.5 py-2">
        <legend className="sr-only">{label}</legend>
        {field.options?.map((option) => (
          <label key={option.value} className="inline-flex items-center gap-1.5 text-sm text-medium">
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option.value);
                else next.delete(option.value);
                onChange(field.options!.map((o) => o.value).filter((v) => next.has(v)));
              }}
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  }
  const numeric = field.type === "numero" || field.type === "moeda" || field.type === "horas";
  return (
    <input
      type="text"
      aria-label={`${label} (separe por ponto e vírgula)`}
      placeholder="valor 1; valor 2"
      className={controlClass}
      defaultValue={values.join("; ")}
      onBlur={(event) => {
        const parts = event.target.value
          .split(";")
          .map((part) => part.trim())
          .filter(Boolean)
          .slice(0, SPEC_LIMITS.values);
        onChange(numeric ? parts.map((part) => Number(part.replace(",", "."))) : parts);
      }}
    />
  );
}

function ConditionRow({
  entity,
  condition,
  index,
  onChange,
  onRemove,
}: {
  entity: ConsultaEntity;
  condition: Condition;
  index: number;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
}) {
  const field = getField(entity, condition.field) ?? entity.fields[0];
  const label = `Filtro ${index + 1}`;
  const { op, value } = condition;
  return (
    <li className="space-y-1.5 rounded-md border border-border bg-surface-muted/40 p-2.5">
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <select
          aria-label={`${label}: campo`}
          className={controlClass}
          value={field.key}
          onChange={(event) => {
            const next = getField(entity, event.target.value);
            if (next) onChange(newCondition(next));
          }}
        >
          {entity.fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} className={iconButtonClass} aria-label={`Remover ${label.toLowerCase()}`}>
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <select
        aria-label={`${label}: operador`}
        className={controlClass}
        value={op}
        onChange={(event) =>
          onChange(changeOperator(field, condition, event.target.value as Condition["op"]))
        }
      >
        {OPS_BY_TYPE[field.type].map((candidate) => (
          <option key={candidate} value={candidate}>
            {OP_LABELS[candidate]}
          </option>
        ))}
      </select>
      {op === "is_null" || op === "not_null" ? null : op === "in" || op === "nin" ? (
        <ListInput
          key={`${field.key}-${op}`}
          field={field}
          label={`${label}: valores`}
          values={Array.isArray(value) ? value : []}
          onChange={(values) => onChange({ ...condition, value: values })}
        />
      ) : op === "between" ? (
        <div className="grid gap-1.5">
          {[0, 1].map((position) => (
            <ScalarInput
              key={position}
              field={field}
              label={`${label}: ${position === 0 ? "de" : "até"}`}
              value={Array.isArray(value) ? value[position] : undefined}
              onChange={(next) => {
                const pair = Array.isArray(value) ? [...value] : [next, next];
                pair[position] = next;
                onChange({ ...condition, value: pair });
              }}
            />
          ))}
        </div>
      ) : (
        <ScalarInput
          field={field}
          label={`${label}: valor`}
          value={Array.isArray(value) ? undefined : value}
          onChange={(next) => onChange({ ...condition, value: next })}
        />
      )}
    </li>
  );
}

/** Editor de filtros de 1 nível com lógica E/OU (ESPECIFICAÇÃO §5). */
export function FilterEditor({
  entity,
  filters,
  onChange,
}: {
  entity: ConsultaEntity;
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const conditions = filters?.conditions ?? [];
  const logic = filters?.logic ?? "and";
  const update = (next: Condition[]) =>
    onChange(next.length > 0 ? { logic, conditions: next } : null);

  return (
    <div className="space-y-2">
      {conditions.length > 1 ? (
        <div role="radiogroup" aria-label="Combinar filtros" className="inline-flex rounded-md border border-border p-0.5">
          {(["and", "or"] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="radio"
              aria-checked={logic === candidate}
              onClick={() => onChange({ logic: candidate, conditions })}
              className={cn(
                "rounded px-3 py-1 text-xs font-semibold",
                focusRing,
                logic === candidate ? "bg-ink text-surface" : "text-medium hover:text-strong",
              )}
            >
              {candidate === "and" ? "Todos (E)" : "Qualquer um (OU)"}
            </button>
          ))}
        </div>
      ) : null}
      {conditions.length > 0 ? (
        <ol className="space-y-2">
          {conditions.map((condition, index) => (
            <ConditionRow
              key={`${index}-${condition.field}`}
              entity={entity}
              condition={condition}
              index={index}
              onChange={(next) =>
                update(conditions.map((item, i) => (i === index ? next : item)))
              }
              onRemove={() => update(conditions.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-soft">Sem filtros: todos os registros do seu escopo.</p>
      )}
      {conditions.length < SPEC_LIMITS.conditions ? (
        <button
          type="button"
          onClick={() => update([...conditions, newCondition(entity.fields[0])])}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-3 text-xs font-semibold text-medium hover:text-strong",
            focusRing,
          )}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          Adicionar filtro
        </button>
      ) : null}
    </div>
  );
}
