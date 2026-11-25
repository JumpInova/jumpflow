"use client";

import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { appConfig } from "@/config/app";
import {
  findActiveNav,
  orderGroupChildren,
  resolveFinanceTabHref,
  visibleAdminGroup,
  visibleOrderedNav,
} from "@/lib/navigation";
import type { RoleName } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";
import { focusRing } from "@/lib/styles";
import { BrandMark } from "@/components/brand/BrandMark";
import { NavItem } from "./NavItem";
import { NavGroup } from "./NavGroup";

export interface SidebarProps {
  /** Called after navigating (closes the mobile drawer). */
  onNavigate?: () => void;
  /** Whether a real database connection is configured. */
  databaseConfigured?: boolean;
  /** Current user's roles, used to gate role-restricted items. */
  roles?: RoleName[];
  /**
   * Permission codes (from the matrix) the user may VIEW. Items with a
   * `permissionCode` not in this set are hidden. Items without a code are
   * always shown (subject to the legacy role gate).
   */
  viewableNavCodes?: string[];
  /**
   * Persisted `href → position` order for the primary rail (P28). Applied on
   * top of the default catalog order; unknown items keep the default order.
   */
  navOrder?: Record<string, number>;
  /**
   * Desktop collapse state (P11). When collapsed the rail shows icon-only
   * entries with tooltips. Undefined on the mobile drawer (never collapsed).
   */
  collapsed?: boolean;
  /** Toggles the desktop collapse state. Only rendered when provided. */
  onToggleCollapse?: () => void;
  className?: string;
}

/** Primary navigation rail. Shared by the desktop rail and mobile drawer. */
export function Sidebar({
  onNavigate,
  databaseConfigured = false,
  roles = [],
  viewableNavCodes = [],
  navOrder = {},
  collapsed = false,
  onToggleCollapse,
  className,
}: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The finance dropdown has two entries on the exact same pathname
  // (/app/financeiro) that differ only by `?tab` — Apuração (receber) and
  // Contas a Pagar (?tab=pagar). `findActiveNav` is pathname-only, so it would
  // always light up Apuração; prefer the exact tab href when present.
  const activeHref =
    resolveFinanceTabHref(pathname, searchParams.get("tab")) ??
    findActiveNav(pathname)?.href;
  const viewable = new Set(viewableNavCodes);
  // Árvore do menu na ordem persistida (P28 + grupos): itens soltos e grupos
  // (Projetos & Clientes, Operação, Relatórios & Análises e, para
  // FINANCE/ADMIN, Contas a Receber/Pagar) intercalados conforme a tela
  // Ordem do Menu. Itens com permissionCode são gateados só pela matriz; os
  // demais, pelo gate de papéis. Grupos sem filho visível somem.
  const entries = visibleOrderedNav(navOrder, roles, viewable);
  // Administração continua recolhível (defaultOpen) e sempre por último; só a
  // ordem interna dela é configurável.
  const visibleAdmin = visibleAdminGroup(roles, viewable);
  const adminGroup = visibleAdmin
    ? orderGroupChildren(visibleAdmin, navOrder)
    : undefined;

  return (
    <div className={cn("flex h-full flex-col bg-surface", className)}>
      <div
        className={cn(
          "flex h-16 items-center border-b-2 border-ink",
          collapsed ? "justify-center px-2" : "gap-3 px-5",
        )}
      >
        <Link
          href="/app"
          onClick={onNavigate}
          aria-label={`${appConfig.name} — ir para a tela inicial`}
          className={cn("flex items-center gap-3 rounded-md", focusRing)}
        >
          <BrandMark size={36} />
          {collapsed ? null : (
            <span className="flex flex-col leading-tight">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-soft">
                Jump
              </span>
              <span className="text-sm font-semibold text-strong">
                {appConfig.name}
              </span>
            </span>
          )}
        </Link>
      </div>

      <nav
        aria-label="Navegação principal"
        className={cn(
          "flex-1 space-y-1 overflow-y-auto py-4",
          collapsed ? "px-2" : "px-3",
        )}
      >
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expandir menu" : "Recolher menu"}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
            className={cn(
              "group mb-1 flex w-full items-center rounded-md border-2 border-transparent py-2 text-sm font-medium text-medium transition-colors hover:bg-surface-muted hover:text-strong",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
              focusRing,
            )}
          >
            {collapsed ? (
              <PanelLeftOpen
                aria-hidden="true"
                className="size-[18px] shrink-0 text-soft group-hover:text-medium"
              />
            ) : (
              <PanelLeftClose
                aria-hidden="true"
                className="size-[18px] shrink-0 text-soft group-hover:text-medium"
              />
            )}
            {collapsed ? null : <span className="truncate">Recolher menu</span>}
          </button>
        ) : null}

        {entries.map((entry) =>
          entry.kind === "item" ? (
            <NavItem
              key={entry.key}
              item={entry.item}
              active={entry.item.href === activeHref}
              onNavigate={onNavigate}
              collapsed={collapsed}
            />
          ) : (
            <NavGroup
              key={entry.key}
              group={entry.group}
              activeHref={activeHref}
              onNavigate={onNavigate}
              collapsed={collapsed}
            />
          ),
        )}

        {adminGroup ? (
          <div className="pt-4">
            {collapsed ? (
              <div
                aria-hidden="true"
                className="mx-auto mb-1 h-px w-6 bg-border"
              />
            ) : null}
            <NavGroup
              group={adminGroup}
              activeHref={activeHref}
              onNavigate={onNavigate}
              collapsed={collapsed}
            />
          </div>
        ) : null}
      </nav>

      {collapsed ? null : (
        <div className="border-t border-border px-5 py-4">
          <p className="text-xs leading-5 text-soft">
            {databaseConfigured
              ? "Ambiente de validação. Dados fictícios persistidos em banco."
              : "Ambiente de demonstração. Dados mockados, sem conexão com banco."}
          </p>
        </div>
      )}
    </div>
  );
}
