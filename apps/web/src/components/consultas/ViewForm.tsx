"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import type { RoleName } from "@/lib/auth/roles";
import {
  VISUALIZATION_LABELS,
  VISUALIZATIONS,
  type Sharing,
  type Visualization,
} from "@/lib/consultas/saved";
import { cn } from "@/lib/utils";
import { controlClass } from "./FilterEditor";
import { SharingFields, type SharingValue } from "./SharingFields";

export interface ViewFormValue {
  name: string;
  description: string;
  visualization: Visualization;
  sharing: Sharing;
  sharedRoles: RoleName[];
}

export interface ViewFormProps {
  initial: ViewFormValue;
  canShare: boolean;
  /** Dica sobre gráficos (ex.: consulta sem agrupamento). */
  chartHint?: string;
  submitLabel: string;
  pending: boolean;
  error: string | null;
  onSubmit: (value: ViewFormValue) => void;
  idPrefix: string;
  secondaryAction?: React.ReactNode;
}

/** Campos de uma visão salva: nome, descrição, visualização e compartilhamento. */
export function ViewForm({
  initial,
  canShare,
  chartHint,
  submitLabel,
  pending,
  error,
  onSubmit,
  idPrefix,
  secondaryAction,
}: ViewFormProps) {
  const [value, setValue] = useState<ViewFormValue>(initial);
  const sharing: SharingValue = { sharing: value.sharing, sharedRoles: value.sharedRoles };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <label className="block space-y-1 text-sm font-medium text-strong" htmlFor={`${idPrefix}-name`}>
        Nome
        <input
          id={`${idPrefix}-name`}
          required
          maxLength={120}
          className={controlClass}
          value={value.name}
          onChange={(event) => setValue({ ...value, name: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm font-medium text-strong" htmlFor={`${idPrefix}-description`}>
        Descrição <span className="font-normal text-soft">(opcional)</span>
        <textarea
          id={`${idPrefix}-description`}
          maxLength={500}
          rows={2}
          className={cn(controlClass, "h-auto py-2")}
          value={value.description}
          onChange={(event) => setValue({ ...value, description: event.target.value })}
        />
      </label>
      <label className="block space-y-1 text-sm font-medium text-strong" htmlFor={`${idPrefix}-visualization`}>
        Visualização
        <select
          id={`${idPrefix}-visualization`}
          className={controlClass}
          value={value.visualization}
          onChange={(event) => setValue({ ...value, visualization: event.target.value as Visualization })}
        >
          {VISUALIZATIONS.map((option) => (
            <option key={option} value={option}>
              {VISUALIZATION_LABELS[option]}
            </option>
          ))}
        </select>
        {chartHint && value.visualization !== "TABLE" && value.visualization !== "INDICATOR" ? (
          <span className="block text-xs font-normal text-soft">{chartHint}</span>
        ) : null}
      </label>
      <SharingFields
        idPrefix={idPrefix}
        canShare={canShare}
        value={sharing}
        onChange={(next) => setValue({ ...value, ...next })}
      />
      {error ? (
        <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <ActionButton type="submit" icon={Save} disabled={pending}>
          {pending ? "Salvando…" : submitLabel}
        </ActionButton>
        {secondaryAction}
      </div>
    </form>
  );
}
