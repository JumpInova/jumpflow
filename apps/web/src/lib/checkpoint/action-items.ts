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
export type TeamsTranscriptStatusView =
  | "PENDING"
  | "WAITING_TRANSCRIPT"
  | "GENERATING"
  | "DONE"
  | "NO_TRANSCRIPT"
  | "FAILED";

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
  /** M3: transcrição do Teams (null = reunião sem link Teams). */
  teams?: {
    status: TeamsTranscriptStatusView | null;
    mode: "GENERATE" | "SUPPLEMENT" | null;
    /** Código curto (ex.: access_denied), nunca conteúdo. */
    lastError: string | null;
    aiSummary: boolean;
    truncated: boolean;
    lastCheckedAt: string | null;
    nextAttemptAt: string | null;
    /**
     * O viewer (gestor do checkpoint, com Teams ativo e organizador da reunião)
     * pode buscar agora: "generate" (rascunho sem conteúdo) ou "supplement"
     * (já há ata/notas — só complementa). null = sem ação.
     */
    action: "generate" | "supplement" | null;
  } | null;
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

export const teamsTranscriptStatusLabels: Record<TeamsTranscriptStatusView, string> = {
  PENDING: "Aguardando a primeira consulta",
  WAITING_TRANSCRIPT: "Aguardando a transcrição",
  GENERATING: "Gerando a ata",
  DONE: "Ata da transcrição do Teams",
  NO_TRANSCRIPT: "Sem transcrição",
  FAILED: "Transcrição indisponível",
};

/** Texto curto para o código de erro da transcrição (sem detalhe técnico). */
export function teamsTranscriptErrorLabel(code: string | null): string | null {
  if (!code) return null;
  if (code === "access_denied") return "A Microsoft negou o acesso à transcrição (sem nova tentativa por 24 h).";
  if (code === "transcript_too_large") return "A transcrição é grande demais para ser lida.";
  if (code === "not_organizer") return "A reunião não foi organizada pela sua conta.";
  if (code === "superseded" || code === "checkpoint_changed") return "O checkpoint já tem ata ou notas: use “Complementar”.";
  if (code === "meeting_not_found") return "A reunião ainda não foi encontrada no Teams.";
  if (code === "empty_transcript") return "A transcrição ainda está vazia.";
  return null;
}

export function canTransitionActionItem(from: ActionItemStatus, to: ActionItemStatus): boolean {
  if (from === "PENDING") return to === "ACCEPTED" || to === "DISMISSED" || to === "DONE";
  if (from === "ACCEPTED") return to === "DONE" || to === "DISMISSED";
  return false;
}

// ── Deduplicação de cards (complemento da ata, M3) ───────────────────────────

/**
 * Título/responsável/prazo normalizados para comparar cards: minúsculo, sem
 * acentos, só letras/dígitos separados por um espaço. Entrada já limitada (saída
 * da IA ≤ 300 caracteres); as regexes sempre avançam (lineares). PURA.
 */
export function normalizeCardText(value: string | null | undefined): string {
  return String(value ?? "")
    .slice(0, 1000)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface ActionItemKeyInput {
  title: string;
  ownerText: string | null;
  dueDate: Date | null;
  dueText: string | null;
}

function dueKey(item: ActionItemKeyInput): string {
  return item.dueDate ? item.dueDate.toISOString().slice(0, 10).replace(/-/g, " ") : normalizeCardText(item.dueText);
}

/** Campo opcional compatível: igual, ou ausente de um dos lados. */
function compatible(a: string, b: string): boolean {
  return a === "" || b === "" || a === b;
}

/** Mesmo card? Título normalizado igual e responsável/prazo compatíveis. PURA. */
export function sameActionItem(a: ActionItemKeyInput, b: ActionItemKeyInput): boolean {
  return (
    normalizeCardText(a.title) === normalizeCardText(b.title) &&
    compatible(normalizeCardText(a.ownerText), normalizeCardText(b.ownerText)) &&
    compatible(dueKey(a), dueKey(b))
  );
}

/**
 * Só os cards NOVOS: descarta os que já existem no checkpoint (qualquer status —
 * PENDING/ACCEPTED/DONE contam, e um DISMISSED nunca é reaberto) e duplicados
 * dentro do próprio lote. Agrupa por título normalizado (sem N²). PURA.
 */
export function filterNewActionItems<T extends ActionItemKeyInput>(incoming: T[], existing: ActionItemKeyInput[]): T[] {
  const byTitle = new Map<string, ActionItemKeyInput[]>();
  const add = (item: ActionItemKeyInput) => {
    const key = normalizeCardText(item.title);
    const list = byTitle.get(key) ?? [];
    list.push(item);
    byTitle.set(key, list);
  };
  for (const item of existing) add(item);
  const out: T[] = [];
  for (const item of incoming) {
    const peers = byTitle.get(normalizeCardText(item.title)) ?? [];
    if (peers.some((p) => sameActionItem(p, item))) continue;
    out.push(item);
    add(item);
  }
  return out;
}
