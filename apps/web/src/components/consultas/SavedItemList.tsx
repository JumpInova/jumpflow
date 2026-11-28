import Link from "next/link";
import { Globe2, Lock, TriangleAlert, Users } from "lucide-react";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { roleLabels, type RoleName } from "@/lib/auth/roles";
import { SHARING_LABELS, type Sharing } from "@/lib/consultas/saved";
import { focusRing } from "@/lib/styles";
import { cn } from "@/lib/utils";

export interface SavedListItem {
  id: string;
  href: string;
  name: string;
  description: string | null;
  /** Ex.: "Horas · Barras". */
  meta: string;
  sharing: Sharing;
  sharedRoles: RoleName[];
  ownerName: string;
  isOwner: boolean;
  /** false = só o dono vê; a spec não roda mais com a permissão atual. */
  available?: boolean;
  updatedAt: string;
}

const DATE = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" });

export function SharingBadge({ sharing, sharedRoles }: { sharing: Sharing; sharedRoles: readonly RoleName[] }) {
  if (sharing === "PRIVATE") {
    return (
      <StatusBadge tone="neutral" icon={<Lock className="size-3" />}>
        {SHARING_LABELS.PRIVATE}
      </StatusBadge>
    );
  }
  if (sharing === "ALL") {
    return (
      <StatusBadge tone="info" icon={<Globe2 className="size-3" />}>
        Todos
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="info" icon={<Users className="size-3" />}>
      {sharedRoles.map((role) => roleLabels[role]).join(", ")}
    </StatusBadge>
  );
}

/** Lista de visões ou painéis (cartões clicáveis). */
export function SavedItemList({ items, showOwner }: { items: SavedListItem[]; showOwner: boolean }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={item.href}
            className={cn(
              "flex h-full flex-col gap-2 rounded-md border border-border bg-surface p-4 transition-colors hover:border-ink",
              focusRing,
            )}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="font-semibold text-strong">{item.name}</span>
              <SharingBadge sharing={item.sharing} sharedRoles={item.sharedRoles} />
            </span>
            <span className="text-xs font-medium uppercase tracking-wide text-soft">{item.meta}</span>
            {item.description ? (
              <span className="line-clamp-2 text-sm text-medium">{item.description}</span>
            ) : null}
            {item.available === false ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning">
                <TriangleAlert aria-hidden="true" className="size-3.5" />
                Usa dados que seu perfil não pode mais consultar
              </span>
            ) : null}
            <span className="mt-auto text-xs text-soft">
              {showOwner ? `${item.ownerName} · ` : null}
              Atualizada em {DATE.format(new Date(item.updatedAt))}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
