import type { GraphMessage } from "../graph/types";

/**
 * Seleção da mensagem de ata de um Checkpoint (M365 M2). PURO.
 *
 * Ingestão ESTREITA: só a caixa do GESTOR é consultada, por duas consultas
 * (categoria `JumpFlow` e assunto do evento). Esta regra decide qual das
 * mensagens devolvidas é a ata deste checkpoint:
 *
 * - categoria `JumpFlow` (na caixa do gestor), recebida desde o início do
 *   evento, que também aponte para ESTE checkpoint (consultor em from/to/cc ou
 *   assunto do evento) — categoria sozinha não basta, senão a ata de um 1:1
 *   alimentaria o checkpoint de outro consultor do mesmo gestor;
 * - assunto contendo o assunto do evento (normalizado, sem RE:/ENC:/FW:),
 *   recebida entre o início do evento e +7 dias, com o consultor OU o gestor em
 *   from/to/cc.
 *
 * Pontuação: categoria 4, assunto 2, consultor envolvido 1. A maior vence;
 * empate na maior pontuação entre 2+ mensagens = ambíguo (o gestor escolhe na
 * tela). Convites/respostas de reunião, rascunhos e mensagens cujo
 * `internetMessageId` já alimentou outro Checkpoint são descartados.
 */

export const MINUTES_CATEGORY = "JumpFlow";
export const MINUTES_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

/** Prefixos de resposta/encaminhamento (PT/EN/ES/DE/FR), repetidos ou não. */
const REPLY_PREFIX_RE =
  // `\s*` adjacentes só quando há "[n]" entre eles (sem sobreposição).
  /^\s*(?:(?:re|res|enc|fw|fwd|tr|rv|aw|wg|sv|antw|ref)\s*(?:\[\d{1,4}\]\s*)?:\s*)+/i;
/** Respostas automáticas de convite (não são atas). */
const MEETING_RESPONSE_RE =
  /^\s*(?:aceito|aceita|accepted|recusado|recusada|declined|provis[oó]rio|tentative|tentatively accepted|cancelado|cancelada|canceled|cancelled|atualizado|updated|convite|invitation|novo hor[aá]rio proposto|new time proposed)\s*:/i;

/** Assunto normalizado: sem prefixos RE:/ENC:/FW:, sem acento/pontuação, minúsculo. */
export function normalizeSubject(subject: string | null | undefined): string {
  // Assunto truncado antes de qualquer regex (defesa em profundidade).
  let s = String(subject ?? "").slice(0, 1000);
  // Prefixos podem vir encadeados ("RE: ENC: RES:").
  for (let i = 0; i < 5; i += 1) {
    const next = s.replace(REPLY_PREFIX_RE, "");
    if (next === s) break;
    s = next;
  }
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** O assunto da mensagem CONTÉM o assunto do evento (palavras inteiras). */
export function subjectMatches(messageSubject: string | null | undefined, eventSubject: string | null | undefined): boolean {
  const event = normalizeSubject(eventSubject);
  if (event.length < 3) return false;
  const message = normalizeSubject(messageSubject);
  return ` ${message} `.includes(` ${event} `);
}

export function isMeetingResponseSubject(subject: string | null | undefined): boolean {
  return MEETING_RESPONSE_RE.test(String(subject ?? "").slice(0, 1000));
}

export interface MinutesCandidate {
  messageId: string;
  internetMessageId: string;
  subject: string | null;
  receivedAt: Date;
  webLink: string | null;
  fromEmail: string | null;
  fromName: string | null;
  /** e-mails (minúsculos) em from/to/cc. */
  participants: string[];
  categories: string[];
  hasAttachments: boolean;
}

function lower(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  return v.includes("@") ? v : null;
}

/** webLink do Outlook: só https em host da Microsoft. */
export function sanitizeOutlookLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return host.endsWith(".office.com") ||
      host.endsWith(".office365.com") ||
      host.endsWith(".cloud.microsoft") ||
      host === "outlook.office.com" ||
      host === "outlook.live.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Metadados do Graph → candidata. Descarta convites/respostas de reunião
 * (`eventMessage*`), rascunhos e mensagens sem id/internetMessageId/data.
 */
export function toCandidate(message: GraphMessage): MinutesCandidate | null {
  const raw = message;
  if (!raw?.id || !raw.internetMessageId) return null;
  if (String(raw["@odata.type"] ?? "").toLowerCase().includes("eventmessage")) return null;
  if (raw.isDraft) return null;
  if (isMeetingResponseSubject(raw.subject)) return null;
  const receivedMs = Date.parse(raw.receivedDateTime ?? "");
  if (!Number.isFinite(receivedMs)) return null;
  const fromEmail = lower(raw.from?.emailAddress?.address);
  const participants = new Set<string>();
  if (fromEmail) participants.add(fromEmail);
  for (const r of [...(raw.toRecipients ?? []), ...(raw.ccRecipients ?? [])]) {
    const email = lower(r?.emailAddress?.address);
    if (email) participants.add(email);
  }
  return {
    messageId: raw.id,
    internetMessageId: raw.internetMessageId.trim(),
    subject: raw.subject?.trim() || null,
    receivedAt: new Date(receivedMs),
    webLink: sanitizeOutlookLink(raw.webLink),
    fromEmail,
    fromName: raw.from?.emailAddress?.name?.trim() || null,
    participants: [...participants],
    categories: (raw.categories ?? []).filter((c): c is string => typeof c === "string"),
    hasAttachments: Boolean(raw.hasAttachments),
  };
}

/** Uma candidata por internetMessageId (cópia em Enviados + Caixa de entrada). */
export function dedupeCandidates(candidates: MinutesCandidate[]): MinutesCandidate[] {
  const byId = new Map<string, MinutesCandidate>();
  for (const c of candidates) {
    const key = c.internetMessageId.toLowerCase();
    const existing = byId.get(key);
    if (!existing || c.receivedAt < existing.receivedAt) byId.set(key, c);
  }
  return [...byId.values()];
}

export interface SelectionContext {
  eventSubject: string | null;
  eventStartAt: Date;
  /** e-mails do GESTOR (caixa conectada + login). */
  managerEmails: string[];
  /** e-mails do consultor do checkpoint. */
  consultantEmails: string[];
  /** internetMessageIds que já alimentaram OUTRO checkpoint. */
  usedInternetMessageIds: ReadonlySet<string>;
  now: Date;
}

export interface ScoredCandidate {
  candidate: MinutesCandidate;
  score: number;
  categoryMatch: boolean;
  subjectMatch: boolean;
  consultantInvolved: boolean;
}

export function minutesWindow(eventStartAt: Date, now: Date): { since: Date; subjectUntil: Date; categoryUntil: Date } {
  const subjectUntil = new Date(
    Math.min(eventStartAt.getTime() + MINUTES_WINDOW_DAYS * DAY_MS, now.getTime()),
  );
  return { since: eventStartAt, subjectUntil, categoryUntil: now };
}

/** Pontua UMA candidata; null = não elegível para este checkpoint. */
export function scoreCandidate(candidate: MinutesCandidate, ctx: SelectionContext): ScoredCandidate | null {
  if (ctx.usedInternetMessageIds.has(candidate.internetMessageId.toLowerCase())) return null;
  const window = minutesWindow(ctx.eventStartAt, ctx.now);
  const at = candidate.receivedAt.getTime();
  if (at < window.since.getTime()) return null;
  const managers = new Set(ctx.managerEmails.map((e) => e.toLowerCase()));
  const consultants = new Set(ctx.consultantEmails.map((e) => e.toLowerCase()));
  const consultantInvolved = candidate.participants.some((p) => consultants.has(p));
  const managerInvolved = candidate.participants.some((p) => managers.has(p));
  const categoryMatch =
    at <= window.categoryUntil.getTime() &&
    candidate.categories.some((c) => c.trim().toLowerCase() === MINUTES_CATEGORY.toLowerCase());
  const subjectMatch = subjectMatches(candidate.subject, ctx.eventSubject);
  const inSubjectWindow = at <= window.subjectUntil.getTime();

  const eligibleByCategory = categoryMatch && (consultantInvolved || subjectMatch);
  const eligibleBySubject = subjectMatch && inSubjectWindow && (consultantInvolved || managerInvolved);
  if (!eligibleByCategory && !eligibleBySubject) return null;
  return {
    candidate,
    score: (categoryMatch ? 4 : 0) + (subjectMatch ? 2 : 0) + (consultantInvolved ? 1 : 0),
    categoryMatch,
    subjectMatch,
    consultantInvolved,
  };
}

export type MinutesSelection =
  | { kind: "none" }
  | { kind: "selected"; candidate: MinutesCandidate; score: number }
  | { kind: "ambiguous"; candidates: ScoredCandidate[] };

/** Elegíveis ordenadas (maior pontuação, depois mais recente). */
export function rankCandidates(candidates: MinutesCandidate[], ctx: SelectionContext): ScoredCandidate[] {
  return dedupeCandidates(candidates)
    .map((c) => scoreCandidate(c, ctx))
    .filter((c): c is ScoredCandidate => c !== null)
    .sort((a, b) => b.score - a.score || b.candidate.receivedAt.getTime() - a.candidate.receivedAt.getTime());
}

/**
 * A melhor candidata, ou ambíguo quando 2+ empatam na maior pontuação (nada é
 * escolhido sozinho: o gestor decide na tela).
 */
export function selectMinutesCandidate(candidates: MinutesCandidate[], ctx: SelectionContext): MinutesSelection {
  const ranked = rankCandidates(candidates, ctx);
  if (ranked.length === 0) return { kind: "none" };
  const top = ranked.filter((c) => c.score === ranked[0].score);
  if (top.length > 1) return { kind: "ambiguous", candidates: top };
  return { kind: "selected", candidate: ranked[0].candidate, score: ranked[0].score };
}
