import type { AppUser } from "@/lib/auth/types";
import type { PanelViewOption } from "@/components/consultas/PanelForm";

/** Visões que o usuário pode colocar num painel: abertas para ele e utilizáveis. */
export async function panelViewOptions(user: AppUser): Promise<PanelViewOption[]> {
  const { listSavedViews } = await import("@/lib/db/consultas-saved");
  const { mine, shared } = await listSavedViews(user);
  return [...mine, ...shared]
    .filter((view) => view.available)
    .map((view) => ({
      id: view.id,
      name: view.name,
      entityLabel: view.entityLabel,
      visualization: view.visualization,
    }));
}
