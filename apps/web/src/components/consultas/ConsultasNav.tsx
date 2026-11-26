"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenText, CalendarClock, LayoutDashboard, Bookmark, Wrench } from "lucide-react";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

export interface ConsultasNavProps {
  /** `CONSULTAS_CRIAR`: mostra o construtor. */
  canCreate: boolean;
  /** `CONSULTAS_AGENDAR`: mostra os agendamentos de envio. */
  canSchedule?: boolean;
}

const LINKS = [
  { href: "/app/consultas", label: "Construtor", icon: Wrench, needs: "create" },
  { href: "/app/consultas/visoes", label: "Visões", icon: Bookmark, needs: null },
  { href: "/app/consultas/paineis", label: "Painéis", icon: LayoutDashboard, needs: null },
  { href: "/app/consultas/agendamentos", label: "Agendamentos", icon: CalendarClock, needs: "schedule" },
  { href: "/app/consultas/catalogo", label: "Catálogo de dados", icon: BookOpenText, needs: null },
] as const;

/** Abas do módulo Consultas (o gate real de cada tela é no servidor). */
export function ConsultasNav({ canCreate, canSchedule = false }: ConsultasNavProps) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Seções de Consultas" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-border px-1">
        {LINKS.filter(
          (link) =>
            link.needs === null ||
            (link.needs === "create" && canCreate) ||
            (link.needs === "schedule" && canSchedule),
        ).map((link) => {
          const active =
            link.href === "/app/consultas" ? pathname === link.href : pathname.startsWith(link.href);
          const Icon = link.icon;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex h-10 items-center gap-2 border-b-2 px-3 text-sm font-semibold",
                  focusRing,
                  active
                    ? "border-ink text-strong"
                    : "border-transparent text-medium hover:text-strong",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
