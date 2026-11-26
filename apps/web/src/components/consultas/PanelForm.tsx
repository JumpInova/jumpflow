"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Save, Trash2, X } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { atualizarPainel, excluirPainel, salvarPainel } from "@/app/app/consultas/visoes/actions";
import type { RoleName } from "@/lib/auth/roles";
import {
  MAX_PANEL_ITEMS,
  VISUALIZATION_LABELS,
  type PanelItemSize,
  type Sharing,
  type Visualization,
} from "@/lib/consultas/saved";
import { cn } from "@/lib/utils";
import { controlClass, iconButtonClass } from "./FilterEditor";
import { SharingFields } from "./SharingFields";

export interface PanelViewOption {
  id: string;
  name: string;
  entityLabel: string;
  visualization: Visualization;
}

export interface PanelFormValue {
  name: string;
  description: string;
  items: { viewId: string; size: PanelItemSize }[];
  sharing: Sharing;
  sharedRoles: RoleName[];
}

export interface PanelFormProps {
  /** Visões que o usuário pode abrir agora (já filtradas no servidor). */
  views: PanelViewOption[];
  initial: PanelFormValue;
  canShare: boolean;
  /** Edição de painel existente (dono). */
  panelId?: string;
  /**
   * Itens gravados que o dono não pode abrir hoje. O cliente só recebe a
   * contagem (nunca ids/nomes); o dono escolhe mantê-los ou removê-los.
   */
  unavailableCount?: number;
}

/**
 * Monta um painel com até 24 visões. Itens já gravados que o dono não pode
 * mais abrir ficam preservados (o painel os oculta de quem não pode vê-los),
 * mas não aparecem com nome aqui.
 */
export function PanelForm({ views, initial, canShare, panelId, unavailableCount = 0 }: PanelFormProps) {
  const router = useRouter();
  const [value, setValue] = useState<PanelFormValue>(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [removeUnavailable, setRemoveUnavailable] = useState(false);
  const [pending, startTransition] = useTransition();
  const byId = useMemo(() => new Map(views.map((view) => [view.id, view])), [views]);
  const selected = new Set(value.items.map((item) => item.viewId));
  const keptUnavailable = removeUnavailable ? 0 : unavailableCount;
  const full = value.items.length + keptUnavailable >= MAX_PANEL_ITEMS;

  function move(index: number, delta: number) {
    const items = [...value.items];
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
    setValue({ ...value, items });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const form = {
        ...value,
        // Só itens que o dono pode abrir; os indisponíveis o servidor resolve.
        items: value.items.filter((item) => byId.has(item.viewId)),
        description: value.description || null,
        keepUnavailable: !removeUnavailable,
      };
      if (panelId) {
        const response = await atualizarPainel(panelId, form);
        if (!response.ok) {
          setError(response.error);
          return;
        }
        router.push(`/app/consultas/paineis/${panelId}`);
        return;
      }
      const response = await salvarPainel(form);
      if (!response.ok) {
        setError(response.error);
        return;
      }
      router.push(`/app/consultas/paineis/${response.data.id}`);
    });
  }

  function remove() {
    if (!panelId) return;
    startTransition(async () => {
      const response = await excluirPainel(panelId);
      if (!response.ok) {
        setError(response.error);
        setConfirming(false);
        return;
      }
      router.push("/app/consultas/paineis");
    });
  }

  return (
    <form className="grid gap-6 lg:grid-cols-2" onSubmit={submit}>
      <div className="space-y-4">
        <label className="block space-y-1 text-sm font-medium text-strong" htmlFor="panel-name">
          Nome
          <input
            id="panel-name"
            required
            maxLength={120}
            className={controlClass}
            value={value.name}
            onChange={(event) => setValue({ ...value, name: event.target.value })}
          />
        </label>
        <label className="block space-y-1 text-sm font-medium text-strong" htmlFor="panel-description">
          Descrição <span className="font-normal text-soft">(opcional)</span>
          <textarea
            id="panel-description"
            maxLength={500}
            rows={2}
            className={cn(controlClass, "h-auto py-2")}
            value={value.description}
            onChange={(event) => setValue({ ...value, description: event.target.value })}
          />
        </label>
        <SharingFields
          idPrefix="panel"
          canShare={canShare}
          value={{ sharing: value.sharing, sharedRoles: value.sharedRoles }}
          onChange={(next) => setValue({ ...value, ...next })}
        />
        <p className="text-xs text-soft">
          Quem abrir o painel só vê as visões que o próprio perfil pode abrir; as demais não aparecem (nem o nome).
        </p>
      </div>

      <div className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-strong">
            Visões no painel ({value.items.length + keptUnavailable}/{MAX_PANEL_ITEMS})
          </legend>
          {value.items.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-medium">
              Escolha as visões na lista abaixo.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {value.items.map((item, index) => {
                const view = byId.get(item.viewId);
                if (!view) return null;
                return (
                  <li key={item.viewId} className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-1.5">
                    <span className="min-w-0 truncate text-sm text-strong" title={view.name}>
                      {view.name}
                      <span className="ml-1 text-xs text-soft">
                        · {view.entityLabel} · {VISUALIZATION_LABELS[view.visualization]}
                      </span>
                    </span>
                    <select
                      aria-label={`Largura de ${view.name}`}
                      className={cn(controlClass, "w-24")}
                      value={item.size}
                      onChange={(event) =>
                        setValue({
                          ...value,
                          items: value.items.map((it) =>
                            it.viewId === item.viewId ? { ...it, size: event.target.value as PanelItemSize } : it,
                          ),
                        })
                      }
                    >
                      <option value="normal">Normal</option>
                      <option value="largo">Largo</option>
                    </select>
                    <button type="button" className={iconButtonClass} aria-label={`Subir ${view.name}`} onClick={() => move(index, -1)} disabled={index === 0}>
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </button>
                    <button type="button" className={iconButtonClass} aria-label={`Descer ${view.name}`} onClick={() => move(index, 1)} disabled={index === value.items.length - 1}>
                      <ArrowDown aria-hidden="true" className="size-4" />
                    </button>
                    <button
                      type="button"
                      className={iconButtonClass}
                      aria-label={`Remover ${view.name}`}
                      onClick={() => setValue({ ...value, items: value.items.filter((it) => it.viewId !== item.viewId) })}
                    >
                      <X aria-hidden="true" className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
          {unavailableCount > 0 ? (
            <div className="space-y-1 rounded-md border border-border bg-surface-muted px-3 py-2">
              <p className="text-xs text-medium">
                {unavailableCount === 1
                  ? "1 visão deste painel não está disponível para você"
                  : `${unavailableCount} visões deste painel não estão disponíveis para você`}{" "}
                (excluída, privada ou de dados que seu perfil não consulta).{" "}
                {removeUnavailable ? "Será removida ao salvar." : "Será mantida no fim do painel."}
              </p>
              <label className="flex items-center gap-2 text-xs font-medium text-strong">
                <input
                  type="checkbox"
                  checked={removeUnavailable}
                  onChange={(event) => setRemoveUnavailable(event.target.checked)}
                />
                {unavailableCount === 1 ? "Remover a visão indisponível" : `Remover as ${unavailableCount} visões indisponíveis`}
              </label>
            </div>
          ) : null}
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-sm font-medium text-strong">Adicionar visões</legend>
          {views.length === 0 ? (
            <p className="text-sm text-medium">Nenhuma visão disponível. Salve uma visão no construtor primeiro.</p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2.5">
              {views.map((view) => (
                <label key={view.id} className="flex items-center gap-2 text-sm text-medium">
                  <input
                    type="checkbox"
                    checked={selected.has(view.id)}
                    disabled={!selected.has(view.id) && full}
                    onChange={(event) =>
                      setValue({
                        ...value,
                        items: event.target.checked
                          ? [...value.items, { viewId: view.id, size: "normal" }]
                          : value.items.filter((item) => item.viewId !== view.id),
                      })
                    }
                  />
                  <span className="min-w-0 truncate">
                    {view.name} <span className="text-xs text-soft">· {view.entityLabel}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>

      <div className="space-y-3 lg:col-span-2">
        {error ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton type="submit" icon={Save} disabled={pending || value.items.length === 0}>
            {pending ? "Salvando…" : panelId ? "Salvar painel" : "Criar painel"}
          </ActionButton>
          {panelId ? (
            confirming ? (
              <>
                <span className="text-sm text-medium">Excluir este painel para todos?</span>
                <ActionButton type="button" size="sm" variant="danger" icon={Trash2} disabled={pending} onClick={remove}>
                  Sim, excluir
                </ActionButton>
                <ActionButton type="button" size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                  Cancelar
                </ActionButton>
              </>
            ) : (
              <ActionButton type="button" size="sm" variant="danger" icon={Trash2} onClick={() => setConfirming(true)}>
                Excluir painel
              </ActionButton>
            )
          ) : null}
        </div>
      </div>
    </form>
  );
}
