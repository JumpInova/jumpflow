"use client";

import { roleLabels, type RoleName } from "@/lib/auth/roles";
import {
  SHAREABLE_ROLES,
  SHARING_LABELS,
  SHARING_MODES,
  type Sharing,
} from "@/lib/consultas/saved";

export interface SharingValue {
  sharing: Sharing;
  sharedRoles: RoleName[];
}

export interface SharingFieldsProps {
  value: SharingValue;
  onChange: (value: SharingValue) => void;
  /** `CONSULTAS_COMPARTILHAR`: sem ela, só "Só eu" (o servidor revalida). */
  canShare: boolean;
  idPrefix: string;
}

/**
 * Compartilhamento de visão/painel: só eu, papéis selecionados ou todos com
 * acesso a Consultas. Lembrete fixo: quem abre vê com a PRÓPRIA permissão.
 */
export function SharingFields({ value, onChange, canShare, idPrefix }: SharingFieldsProps) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-strong">Compartilhamento</legend>
      <div className="space-y-1.5">
        {SHARING_MODES.map((mode) => {
          const disabled = mode !== "PRIVATE" && !canShare;
          return (
            <label
              key={mode}
              className={`flex items-center gap-2 text-sm ${disabled ? "text-soft" : "text-medium"}`}
            >
              <input
                type="radio"
                name={`${idPrefix}-sharing`}
                value={mode}
                checked={value.sharing === mode}
                disabled={disabled}
                onChange={() => onChange({ sharing: mode, sharedRoles: mode === "ROLES" ? value.sharedRoles : [] })}
              />
              {SHARING_LABELS[mode]}
            </label>
          );
        })}
      </div>
      {!canShare ? (
        <p className="text-xs text-soft">
          Seu perfil não tem a permissão “Compartilhar visões”; a visão fica só para você.
        </p>
      ) : null}
      {value.sharing === "ROLES" ? (
        <fieldset className="grid grid-cols-2 gap-1 rounded-md border border-border p-2.5">
          <legend className="sr-only">Papéis com acesso</legend>
          {SHAREABLE_ROLES.map((role) => (
            <label key={role} className="flex items-center gap-2 text-sm text-medium">
              <input
                type="checkbox"
                checked={value.sharedRoles.includes(role)}
                onChange={(event) =>
                  onChange({
                    sharing: "ROLES",
                    sharedRoles: event.target.checked
                      ? [...value.sharedRoles, role]
                      : value.sharedRoles.filter((item) => item !== role),
                  })
                }
              />
              {roleLabels[role]}
            </label>
          ))}
        </fieldset>
      ) : null}
      {value.sharing !== "PRIVATE" ? (
        <p className="text-xs text-soft">
          Quem abrir vê com a própria permissão: entidades, campos financeiros e escopo de linha dele.
          Quem não tem acesso à entidade não vê a visão.
        </p>
      ) : null}
    </fieldset>
  );
}
