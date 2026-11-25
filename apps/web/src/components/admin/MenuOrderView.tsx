"use client";

import { useState, useTransition } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, ChevronUp, Lock, RotateCcw } from "lucide-react";
import { ActionButton } from "@/components/ui/ActionButton";
import { SectionPanel } from "@/components/ui/SectionPanel";
import {
  adminGroupedNavigation,
  buildOrderedNav,
  financeGroupedNavigation,
  orderGroupChildren,
  type NavGroupDef,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { focusRing } from "@/lib/styles";
import { saveMenuOrder } from "@/app/app/admin/menu/actions";

interface LeafNode {
  key: string;
  label: string;
  icon: LucideIcon;
}

type TopNode =
  | ({ kind: "item" } & LeafNode)
  | ({ kind: "group"; children: LeafNode[]; finance: boolean } & LeafNode);

interface EditorState {
  top: TopNode[];
  /** Filhos da Administração (o grupo em si é fixo no fim do menu). */
  admin: LeafNode[];
}

const financeKeys = new Set(financeGroupedNavigation.map((g) => g.key));

function leavesOf(group: NavGroupDef): LeafNode[] {
  return group.children.map((child) => ({
    key: child.href,
    label: child.label,
    icon: child.icon,
  }));
}

/**
 * Árvore inicial a partir da ordem persistida. A tela mostra a visão COMPLETA
 * (com os grupos do Financeiro), que é a do ADMIN.
 */
function buildState(order: Record<string, number>): EditorState {
  const top: TopNode[] = buildOrderedNav(order, { financeGrouped: true }).map(
    (entry) =>
      entry.kind === "item"
        ? {
            kind: "item",
            key: entry.key,
            label: entry.item.label,
            icon: entry.item.icon,
          }
        : {
            kind: "group",
            key: entry.key,
            label: entry.group.label,
            icon: entry.group.icon,
            children: leavesOf(entry.group),
            finance: financeKeys.has(entry.key),
          },
  );
  return {
    top,
    admin: leavesOf(orderGroupChildren(adminGroupedNavigation, order)),
  };
}

/** Chaves achatadas: cada grupo seguido dos seus filhos; Administração por último. */
function flattenKeys(state: EditorState): string[] {
  const keys: string[] = [];
  for (const node of state.top) {
    keys.push(node.key);
    if (node.kind === "group") keys.push(...node.children.map((c) => c.key));
  }
  keys.push(adminGroupedNavigation.key, ...state.admin.map((c) => c.key));
  return keys;
}

function swap<T>(list: T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export interface MenuOrderViewProps {
  /** Persisted `key → position` order (hrefs and `group:*` keys). */
  savedOrder: Record<string, number>;
}

const moveButtonClass = cn(
  "grid size-8 place-items-center rounded-md border border-border text-medium transition-colors hover:bg-surface-muted hover:text-strong disabled:cursor-not-allowed disabled:opacity-40",
  focusRing,
);

function MoveButtons({
  label,
  canUp,
  canDown,
  disabled,
  onMove,
}: {
  label: string;
  canUp: boolean;
  canDown: boolean;
  disabled: boolean;
  onMove: (delta: number) => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={!canUp || disabled}
        aria-label={`Mover ${label} para cima`}
        className={moveButtonClass}
      >
        <ChevronUp aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={!canDown || disabled}
        aria-label={`Mover ${label} para baixo`}
        className={moveButtonClass}
      >
        <ChevronDown aria-hidden="true" className="size-4" />
      </button>
    </span>
  );
}

function ChildList({
  groupLabel,
  items,
  disabled,
  onMove,
}: {
  groupLabel: string;
  items: LeafNode[];
  disabled: boolean;
  onMove: (index: number, delta: number) => void;
}) {
  return (
    <ol
      aria-label={`Telas do grupo ${groupLabel}`}
      className="ml-9 mt-2 space-y-1 border-l-2 border-border pl-3"
    >
      {items.map((child, index) => {
        const Icon = child.icon;
        return (
          <li
            key={child.key}
            className="flex items-center gap-3 rounded-md bg-surface px-2 py-1.5"
          >
            <span className="w-5 shrink-0 text-right text-[11px] font-semibold tabular-nums text-soft">
              {index + 1}
            </span>
            <Icon aria-hidden="true" className="size-4 shrink-0 text-soft" />
            <span className="min-w-0 flex-1 truncate text-sm text-strong">
              {child.label}
            </span>
            <MoveButtons
              label={`${child.label} dentro de ${groupLabel}`}
              canUp={index > 0}
              canDown={index < items.length - 1}
              disabled={disabled}
              onMove={(delta) => onMove(index, delta)}
            />
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Reorder the primary menu (P28), now mirroring the sidebar structure: loose
 * items and GROUPS (with every screen inside them). Groups move as a block
 * among the top-level entries; their screens are reordered inside the group.
 * Administração stays pinned at the end; only its screens are reorderable.
 * Accessible up/down controls (no drag needed). Saving persists the GLOBAL
 * order via a server action; the sidebar picks it up on the next navigation.
 */
export function MenuOrderView({ savedOrder }: MenuOrderViewProps) {
  const [state, setState] = useState<EditorState>(() => buildState(savedOrder));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const moveTop = (index: number, delta: number) => {
    setMsg(null);
    setState((current) => ({ ...current, top: swap(current.top, index, delta) }));
  };

  const moveChild = (groupKey: string, index: number, delta: number) => {
    setMsg(null);
    setState((current) => ({
      ...current,
      top: current.top.map((node) =>
        node.kind === "group" && node.key === groupKey
          ? { ...node, children: swap(node.children, index, delta) }
          : node,
      ),
    }));
  };

  const moveAdmin = (index: number, delta: number) => {
    setMsg(null);
    setState((current) => ({
      ...current,
      admin: swap(current.admin, index, delta),
    }));
  };

  const restoreDefault = () => {
    setMsg(null);
    setState(buildState({}));
  };

  const save = () => {
    setMsg(null);
    start(async () => {
      const result = await saveMenuOrder({ keys: flattenKeys(state) });
      setMsg(
        result.ok
          ? { ok: true, text: "Ordem do menu salva." }
          : { ok: false, text: result.message },
      );
    });
  };

  return (
    <SectionPanel
      title="Ordem do menu principal"
      description="Reordene itens e grupos com as setas; dentro de cada grupo, reordene as telas. A ordem é global (vale para toda a organização) e passa a valer na próxima navegação. Cada pessoa só vê as telas que seu perfil permite."
    >
      <div className="px-5 py-4">
        <ol className="space-y-1.5">
          {state.top.map((node, index) => {
            const Icon = node.icon;
            return (
              <li
                key={node.key}
                className={cn(
                  "rounded-md border border-border px-3 py-2",
                  node.kind === "group" ? "bg-surface-muted/40" : "bg-surface",
                )}
              >
                <div className="flex items-center gap-3">
                  <span className="w-6 shrink-0 text-right text-xs font-semibold tabular-nums text-soft">
                    {index + 1}
                  </span>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-medium" />
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-sm font-medium text-strong">
                      {node.label}
                    </span>
                    {node.kind === "group" ? (
                      <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-medium">
                        Grupo · {node.children.length}{" "}
                        {node.children.length === 1 ? "tela" : "telas"}
                      </span>
                    ) : null}
                  </span>
                  <MoveButtons
                    label={node.kind === "group" ? `o grupo ${node.label}` : node.label}
                    canUp={index > 0}
                    canDown={index < state.top.length - 1}
                    disabled={pending}
                    onMove={(delta) => moveTop(index, delta)}
                  />
                </div>
                {node.kind === "group" ? (
                  <>
                    {node.finance ? (
                      <p className="ml-9 mt-1 text-xs text-soft">
                        Agrupado para Financeiro e Admin. Para os demais perfis,
                        estas telas aparecem soltas nesta posição.
                      </p>
                    ) : null}
                    <ChildList
                      groupLabel={node.label}
                      items={node.children}
                      disabled={pending}
                      onMove={(childIndex, delta) =>
                        moveChild(node.key, childIndex, delta)
                      }
                    />
                  </>
                ) : null}
              </li>
            );
          })}

          <li className="rounded-md border border-dashed border-border bg-surface-muted/40 px-3 py-2">
            <div className="flex items-center gap-3">
              <span className="w-6 shrink-0" aria-hidden="true" />
              <adminGroupedNavigation.icon
                aria-hidden="true"
                className="size-4 shrink-0 text-medium"
              />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate text-sm font-medium text-strong">
                  {adminGroupedNavigation.label}
                </span>
                <span className="shrink-0 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold text-medium">
                  Grupo · {state.admin.length}{" "}
                  {state.admin.length === 1 ? "tela" : "telas"}
                </span>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-xs text-soft">
                <Lock aria-hidden="true" className="size-3.5" />
                Sempre no fim
              </span>
            </div>
            <ChildList
              groupLabel={adminGroupedNavigation.label}
              items={state.admin}
              disabled={pending}
              onMove={moveAdmin}
            />
          </li>
        </ol>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <ActionButton
            type="button"
            variant="primary"
            size="sm"
            onClick={save}
            disabled={pending}
          >
            {pending ? "Salvando..." : "Salvar ordem"}
          </ActionButton>
          <ActionButton
            type="button"
            variant="secondary"
            size="sm"
            icon={RotateCcw}
            onClick={restoreDefault}
            disabled={pending}
          >
            Restaurar padrão
          </ActionButton>
          {msg ? (
            <span
              role="status"
              className={cn(
                "text-xs font-semibold",
                msg.ok ? "text-success" : "text-danger",
              )}
            >
              {msg.text}
            </span>
          ) : null}
        </div>
      </div>
    </SectionPanel>
  );
}
