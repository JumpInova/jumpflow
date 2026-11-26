/**
 * Cards de Ação/próximo passo da ata do Checkpoint (Microsoft 365, M2) e o
 * painel de ata por e-mail. PURO (seguro para componentes cliente e testes).
 *
 * O card nasce PENDING (sugestão da IA) e só muda por clique do gestor:
 * PENDING → ACCEPTED | DONE | DISMISSED; ACCEPTED → DONE | DISMISSED.
 * Herda a visibilidade do Checkpoint: só quem vê o CRU recebe os cards (o
 * consultor avaliado nunca, nem em SHARED).
 */

export type ActionItemStatus = "PENDING" | "ACCEPTED" | "DONE" | "DISMISSED";
export type EmailMinutesStatusView = "SEARCHING" | "AMBIGUOUS" | "DONE" | "FAILED";

export interface CheckpointActionItemView {
  id: string;
  title: string;
  ownerText: string | null;
  /** AAAA-MM-DD */
  dueDate: string | null;
  dueText: string | null;
  sourceQuote: string | null;
  status: ActionItemStatus;
}

export interface CheckpointM365View {
  /** Rascunho veio da agenda (há evento vinculado). */
  linkedToEvent: boolean;
  /** O viewer é o gestor do checkpoint (só ele aciona a busca na própria caixa). */
  isOwnManager: boolean;
  minutes: {
    status: EmailMinutesStatusView;
    webLink: string | null;
    receivedAt: string | null;
    aiSummary: boolean;
    attachmentsUsed: number;
    attachmentsSkipped: number;
    lastCheckedAt: string | null;
  } | null;
  actionItems: CheckpointActionItemView[];
}

export const actionItemStatusLabels: Record<ActionItemStatus, string> = {
  PENDING: "Pendente",
  ACCEPTED: "Aceita",
  DONE: "Concluída",
  DISMISSED: "Descartada",
};

export const emailMinutesStatusLabels: Record<EmailMinutesStatusView, string> = {
  SEARCHING: "Procurando o e-mail da ata",
  AMBIGUOUS: "Escolha o e-mail da ata",
  DONE: "Ata importada do e-mail",
  FAILED: "Não foi possível ler o e-mail",
};

export function canTransitionActionItem(from: ActionItemStatus, to: ActionItemStatus): boolean {
  if (from === "PENDING") return to === "ACCEPTED" || to === "DISMISSED" || to === "DONE";
  if (from === "ACCEPTED") return to === "DONE" || to === "DISMISSED";
  return false;
}
