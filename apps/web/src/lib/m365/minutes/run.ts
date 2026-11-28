import type { AiTextProvider } from "@/lib/ai/provider";
import type { GraphClient } from "../graph/client";
import { errorCode, isGraphError, isInterruption } from "../graph/errors";
import {
  renewManagerLease,
  runWithManagerConnection,
  type ManagerCtx,
  type ManagerRunResult,
} from "../manager-connection";
import { hasTeamsScopes } from "../scopes";
import { ConnectionChangedError, type M365ConnectionRecord, type M365Store } from "../store";
import { emailShouldWaitForTeams, isOrganizedBy } from "../transcripts/schedule";
import { extractAttachmentText, pickAttachments } from "./attachments";
import { messageBodyToText } from "./body";
import {
  MINUTES_SYSTEM_PROMPT,
  buildMinutesPrompt,
  composeSourceText,
  fallbackMinutesNotes,
  formatMinutesNotes,
  limitText,
  mapActionItems,
  parseMinutes,
  type MinutesSourceMeta,
} from "./generate";
import { maskPii, unmaskDeep, type PiiMap } from "./pii";
import { truncateAtSpace } from "./text-safe";
import {
  MINUTES_CATEGORY,
  MINUTES_WINDOW_DAYS,
  minutesWindow,
  normalizeSubject,
  rankCandidates,
  scoreCandidate,
  selectMinutesCandidate,
  toCandidate,
  type MinutesCandidate,
  type SelectionContext,
} from "./select";
import type { MinutesCheckpoint, MinutesStore } from "./store";

/**
 * Atas por e-mail (M365 M2): orquestração com dependências injetadas (store,
 * Graph, IA, extração). Os testes usam store em memória, Graph fake e IA
 * mockada; nada aqui fala com a Microsoft diretamente.
 *
 * Invariantes:
 * - SÓ a caixa do GESTOR do checkpoint (managerUserId) é consultada, e só se
 *   ele tem papel de quem registra checkpoint e não é o próprio consultor. A
 *   caixa do consultor nunca é lida, mesmo que ele tenha conectado a dele.
 * - Lease no banco (o mesmo da conexão): job e acionamento manual nunca leem a
 *   mesma caixa ao mesmo tempo; heartbeat antes de cada checkpoint.
 * - Nenhuma mensagem não escolhida é persistida; da escolhida só os metadados
 *   de origem. O texto vai MASCARADO para a IA e para `transcription`.
 * - Logs só com contadores/códigos.
 */

export const MINUTES_LEASE_MS = 5 * 60_000;
/**
 * Mínimo de texto (sem espaços) de corpo + anexos para ser ata. Abaixo disso
 * nada vira RECORDED: o checkpoint fica FAILED recuperável (o job volta a
 * procurar até o fim da janela de 7 dias).
 */
export const MIN_SOURCE_CHARS = 24;
/**
 * Tetos do texto-fonte ANTES da máscara (defesa em profundidade: nenhuma regex
 * roda sobre texto sem limite). Corte em espaço, nunca no meio de um dado.
 */
export const MAX_BODY_SOURCE_CHARS = 120_000;
export const MAX_ATTACHMENT_SOURCE_CHARS = 60_000;

export interface MaskedExtractionInput {
  maskedNotes: string;
  maskedTranscription: string;
  piiMap: PiiMap;
}

/**
 * Formato aceito de id de mensagem do Graph (base64/base64url do Exchange).
 * Qualquer outra coisa é recusada antes de chamar o Graph.
 */
export function isValidMessageId(id: string): boolean {
  return /^[A-Za-z0-9_\-=+/]{1,512}$/.test(id) && /[A-Za-z0-9]/.test(id);
}
const DAY_MS = 86_400_000;

export interface MinutesDeps {
  store: M365Store;
  minutes: MinutesStore;
  graphFor: (connection: M365ConnectionRecord) => GraphClient;
  ai: AiTextProvider;
  /**
   * Pipeline de extração existente (Oportunidades/Cases/Skills PENDING). Recebe
   * a ata e o texto-fonte MASCARADOS (a IA nunca vê o dado) e o mapa desta
   * execução para desmascarar os cards antes de gravar.
   */
  runExtraction: (checkpointId: string, input: MaskedExtractionInput) => Promise<string>;
  owner: string;
  now?: () => Date;
  leaseMs?: number;
  /** Epoch ms: prazo da rodada (o job para de pegar checkpoints depois dele). */
  deadline?: number;
}

export type ProcessOutcome =
  | "saved"
  | "saved_without_ai"
  | "none"
  | "ambiguous"
  | "failed"
  | "duplicate"
  | "checkpoint_changed"
  | "not_eligible"
  | "not_candidate";

export type { ManagerRunResult, ManagerCtx };

/** Rascunho elegível para receber a ata por e-mail agora? PURA. */
export function isMinutesEligible(cp: MinutesCheckpoint, now: Date): boolean {
  if (cp.checkpointStatus !== "DRAFT") return false;
  if (cp.minutesStatus === "DONE") return false;
  if (cp.eventCancelled) return false;
  if (cp.eventEndAt.getTime() > now.getTime()) return false;
  if (now.getTime() - cp.eventEndAt.getTime() >= MINUTES_WINDOW_DAYS * DAY_MS) return false;
  if (cp.notes && cp.notes.trim()) return false;
  if (cp.transcription && cp.transcription.trim()) return false;
  if (cp.audioStorageKey) return false;
  return true;
}

function nowOf(deps: MinutesDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

async function renewLease(deps: MinutesDeps, connectionId: string): Promise<void> {
  await renewManagerLease(deps, connectionId);
}

/**
 * Executa `fn` com a conexão do GESTOR sob lease. Só usa a conexão do próprio
 * `managerUserId`, ACTIVE, com `Mail.Read` e papel de quem registra checkpoint.
 */
export async function withManagerConnection<T>(
  managerUserId: string,
  deps: MinutesDeps,
  fn: (ctx: ManagerCtx) => Promise<T>,
): Promise<ManagerRunResult<T>> {
  const connectionId = await deps.minutes.connectionIdForUser(managerUserId);
  return runWithManagerConnection(managerUserId, connectionId, deps, { capability: "MAIL", logOperation: "minutes.mail" }, fn);
}

function selectionContext(
  cp: MinutesCheckpoint,
  ctx: ManagerCtx,
  consultantEmails: string[],
  used: Set<string>,
  now: Date,
): SelectionContext {
  return {
    eventSubject: cp.eventSubject,
    eventStartAt: cp.eventStartAt,
    managerEmails: ctx.managerEmails,
    consultantEmails,
    usedInternetMessageIds: used,
    now,
  };
}

/** Consulta ESTREITA na caixa do gestor: categoria + assunto do evento. */
async function gatherCandidates(
  cp: MinutesCheckpoint,
  ctx: ManagerCtx,
  deps: MinutesDeps,
  now: Date,
): Promise<{ candidates: MinutesCandidate[]; selection: SelectionContext }> {
  const window = minutesWindow(cp.eventStartAt, now);
  const raw = await ctx.graph.findMessages({
    kind: "category",
    category: MINUTES_CATEGORY,
    since: window.since.toISOString(),
    until: window.categoryUntil.toISOString(),
  });
  if (normalizeSubject(cp.eventSubject).length >= 3) {
    raw.push(
      ...(await ctx.graph.findMessages({
        kind: "subject",
        subject: cp.eventSubject ?? "",
        since: window.since.toISOString(),
        until: window.subjectUntil.toISOString(),
      })),
    );
  }
  const candidates = raw.map(toCandidate).filter((c): c is MinutesCandidate => c !== null);
  const consultantEmails = await deps.minutes.consultantEmails(cp.consultantId);
  const used = await deps.minutes.usedInternetMessageIds(
    [...new Set(candidates.map((c) => c.internetMessageId.toLowerCase()))],
    cp.checkpointId,
  );
  return { candidates, selection: selectionContext(cp, ctx, consultantEmails, used, now) };
}

/** Lê corpo e anexos da mensagem ESCOLHIDA, gera a ata e grava. */
async function ingestCandidate(
  cp: MinutesCheckpoint,
  candidate: MinutesCandidate,
  ctx: ManagerCtx,
  deps: MinutesDeps,
  now: Date,
): Promise<ProcessOutcome> {
  const body = await ctx.graph.getMessageBody(candidate.messageId);
  // Encaminhamento (ENC:/FW:): preserva o bloco encaminhado.
  let bodyText = truncateAtSpace(messageBodyToText(body, { subject: candidate.subject }), MAX_BODY_SOURCE_CHARS);
  const attachments: Array<{ name: string; text: string }> = [];
  let skipped = 0;
  if (candidate.hasAttachments) {
    const metas = await skippable(() => ctx.graph.listAttachments(candidate.messageId));
    const picked = metas ? pickAttachments(metas) : [];
    if (metas) skipped += metas.filter((m) => m.kind === "file" && !m.isInline).length - picked.length;
    for (const meta of picked) {
      // Anexo que some (404) ou falha: ignora o anexo e segue com o corpo.
      const content = await skippable(() => ctx.graph.getAttachment(candidate.messageId, meta.id));
      const extracted = content ? await extractAttachmentText(meta, content.bytes) : null;
      if (extracted?.kind === "text") {
        attachments.push({ name: extracted.name, text: truncateAtSpace(extracted.text, MAX_ATTACHMENT_SOURCE_CHARS) });
      }
      else skipped += 1;
    }
  }
  const chars = () => (bodyText + attachments.map((a) => a.text).join("")).replace(/\s/g, "").length;
  // Texto próprio + anexos curtos demais ("Segue a ata."): a ata está no bloco
  // citado/encaminhado — preserva-o (sem os cabeçalhos De:/Enviado:/Para:).
  if (chars() < MIN_SOURCE_CHARS) {
    bodyText = truncateAtSpace(messageBodyToText(body, { subject: candidate.subject, keepQuoted: true }), MAX_BODY_SOURCE_CHARS);
  }
  const contentChars = chars();
  const source = composeSourceText({ bodyText, attachments });
  if (contentChars < MIN_SOURCE_CHARS) {
    // Recuperável: FAILED volta a ser procurado pelo job até o fim da janela.
    await deps.minutes.recordSearch(
      cp.checkpointId,
      { status: "FAILED", error: contentChars === 0 ? "empty_source" : "source_too_short" },
      now,
    );
    return "failed";
  }
  // Mascarar ANTES de cortar e de qualquer chamada à IA (corte nunca parte um
  // dado pessoal ao meio). O mapa fica só em memória.
  const { masked: maskedFull, map } = maskPii(source);
  const limited = limitText(maskedFull);
  const masked = limited.text;
  const meta: MinutesSourceMeta = {
    receivedAt: candidate.receivedAt,
    attachmentsUsed: attachments.length,
    attachmentsSkipped: Math.max(0, skipped),
    truncated: limited.truncated,
  };
  const raw = await deps.ai.complete(buildMinutesPrompt({ maskedSource: masked, type: cp.type, truncated: limited.truncated }), {
    system: MINUTES_SYSTEM_PROMPT,
    json: true,
    maxTokens: 2500,
    entityType: "Checkpoint",
    entityId: cp.checkpointId,
  });
  const parsed = parseMinutes(raw);
  const aiSummary = parsed.ok;
  // A ata e os cards são DESMASCARADOS em memória (o gestor lê os dados reais);
  // o texto-fonte guardado continua mascarado.
  const maskedNotes = parsed.ok ? formatMinutesNotes(parsed.data, meta) : fallbackMinutesNotes(meta);
  const readable = parsed.ok ? unmaskDeep(parsed.data, map) : null;
  const saved = await deps.minutes.saveMinutes({
    checkpointId: cp.checkpointId,
    expected: { notes: cp.notes, transcription: cp.transcription },
    notes: readable ? formatMinutesNotes(readable, meta) : maskedNotes,
    transcription: masked,
    source: {
      internetMessageId: candidate.internetMessageId.toLowerCase(),
      webLink: candidate.webLink,
      receivedAt: candidate.receivedAt,
    },
    attachmentsUsed: meta.attachmentsUsed,
    attachmentsSkipped: meta.attachmentsSkipped,
    aiSummary,
    actionItems: readable ? mapActionItems(readable) : [],
    now,
  });
  if (saved === "duplicate_message") {
    await deps.minutes.recordSearch(cp.checkpointId, { status: "SEARCHING", error: "message_already_used" }, now);
    return "duplicate";
  }
  if (saved === "checkpoint_changed") return "checkpoint_changed";

  let extraction = "skipped";
  if (aiSummary) {
    try {
      extraction = await deps.runExtraction(cp.checkpointId, {
        maskedNotes,
        maskedTranscription: masked,
        piiMap: map,
      });
    } catch {
      extraction = "failed";
    }
  }
  if (cp.managerUserId) {
    await deps.minutes.notifyManager({ userId: cp.managerUserId, checkpointId: cp.checkpointId, kind: "ready" });
  }
  await deps.store.logIntegrationEvent({
    operation: "minutes.ingest",
    status: "SUCCESS",
    entityType: "Checkpoint",
    entityId: cp.checkpointId,
    meta: {
      aiSummary,
      aiError: parsed.ok ? null : parsed.reason,
      attachmentsUsed: meta.attachmentsUsed,
      attachmentsSkipped: meta.attachmentsSkipped,
      truncated: limited.truncated,
      actionItems: parsed.ok ? parsed.data.actions.length : 0,
      extraction,
    },
  });
  return aiSummary ? "saved" : "saved_without_ai";
}

/**
 * Chamada ao Graph de um ANEXO: erro do anexo (404, http) vira `null` e o
 * anexo é ignorado; erros da conexão (reauth/config/throttling/prazo) sobem.
 */
async function skippable<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (isGraphError(error) && (error.kind === "not_found" || error.kind === "http") && !isInterruption(error)) {
      return null;
    }
    throw error;
  }
}

/** Busca automática: melhor candidata, ambígua ou nenhuma. */
async function processAuto(cp: MinutesCheckpoint, ctx: ManagerCtx, deps: MinutesDeps): Promise<ProcessOutcome> {
  const now = nowOf(deps);
  const { candidates, selection } = await gatherCandidates(cp, ctx, deps, now);
  const result = selectMinutesCandidate(candidates, selection);
  if (result.kind === "none") {
    await deps.minutes.recordSearch(cp.checkpointId, { status: "SEARCHING", error: null }, now);
    return "none";
  }
  if (result.kind === "ambiguous") {
    // Nenhuma candidata é guardada: só o estado. O gestor escolhe na tela.
    const { previousStatus } = await deps.minutes.recordSearch(cp.checkpointId, { status: "AMBIGUOUS", error: null }, now);
    if (previousStatus !== "AMBIGUOUS" && cp.managerUserId) {
      await deps.minutes.notifyManager({ userId: cp.managerUserId, checkpointId: cp.checkpointId, kind: "choice" });
    }
    await deps.store.logIntegrationEvent({
      operation: "minutes.select",
      status: "SUCCESS",
      entityType: "Checkpoint",
      entityId: cp.checkpointId,
      meta: { ambiguous: true, tied: result.candidates.length },
    });
    return "ambiguous";
  }
  return ingestCandidate(cp, result.candidate, ctx, deps, now);
}

/** O gestor da conta não pode ser o consultor do checkpoint. */
function managerMatches(cp: MinutesCheckpoint, ctx: ManagerCtx): boolean {
  return cp.managerUserId === ctx.user.user.id && ctx.user.consultantId !== cp.consultantId;
}

export interface MinutesJobSummary {
  checkpoints: number;
  managers: number;
  saved: number;
  ambiguous: number;
  none: number;
  failed: number;
  busy: number;
  skipped: number;
  errors: number;
  /** M3: adiados porque a transcrição do Teams tem precedência. */
  deferred: number;
}

/**
 * Precedência (M3): a transcrição do Teams vence o e-mail. O job espera
 * enquanto a transcrição está sendo gerada, ou — reunião Teams organizada pelo
 * gestor com Teams ativo — até 1 h após o fim sem resultado final. PURA.
 */
export function waitsForTeams(cp: MinutesCheckpoint, ctx: Pick<ManagerCtx, "connection" | "managerEmails">, now: Date): boolean {
  return emailShouldWaitForTeams({
    teamsStatus: cp.teamsStatus ?? null,
    teamsLeaseUntil: cp.teamsLeaseUntil ?? null,
    teamsEnabled: hasTeamsScopes(ctx.connection.scopes),
    organizedByManager: isOrganizedBy({ eventOrganizerEmail: cp.eventOrganizerEmail ?? null }, ctx.managerEmails),
    eventJoinUrl: cp.eventJoinUrl ?? null,
    eventEndAt: cp.eventEndAt,
    now,
  });
}

/** Job: processa os rascunhos devidos, agrupados pela conta do gestor. */
export async function runMinutesRound(deps: MinutesDeps, limit = 50): Promise<MinutesJobSummary> {
  const summary: MinutesJobSummary = { checkpoints: 0, managers: 0, saved: 0, ambiguous: 0, none: 0, failed: 0, busy: 0, skipped: 0, errors: 0, deferred: 0 };
  const now = nowOf(deps);
  const due = (await deps.minutes.listDueCheckpoints(now, limit)).filter((cp) => isMinutesEligible(cp, now));
  const byManager = new Map<string, MinutesCheckpoint[]>();
  for (const cp of due) {
    if (!cp.managerUserId) continue;
    const list = byManager.get(cp.managerUserId) ?? [];
    list.push(cp);
    byManager.set(cp.managerUserId, list);
  }
  for (const [managerUserId, list] of byManager) {
    if (deps.deadline !== undefined && Date.now() >= deps.deadline) break;
    summary.managers += 1;
    const result = await withManagerConnection(managerUserId, deps, async (ctx) => {
      for (const cp of list) {
        if (deps.deadline !== undefined && Date.now() >= deps.deadline) break;
        await renewLease(deps, ctx.connection.id);
        summary.checkpoints += 1;
        if (!managerMatches(cp, ctx)) {
          summary.skipped += 1;
          continue;
        }
        if (waitsForTeams(cp, ctx, nowOf(deps))) {
          summary.deferred += 1;
          continue;
        }
        const outcome = await processOneSafely(cp, ctx, deps);
        if (outcome === "saved" || outcome === "saved_without_ai") summary.saved += 1;
        else if (outcome === "ambiguous") summary.ambiguous += 1;
        else if (outcome === "none" || outcome === "duplicate") summary.none += 1;
        else if (outcome === "failed") summary.failed += 1;
        else summary.skipped += 1;
      }
    });
    if (result.status === "busy") summary.busy += 1;
    else if (result.status === "error") summary.errors += 1;
    else if (result.status === "skipped" || result.status === "interrupted") summary.skipped += 1;
  }
  return summary;
}

/**
 * Erros por checkpoint (mensagem apagada, anexo ilegível) não derrubam a
 * rodada; erros da conexão (reauth/config/interrupção) sobem.
 */
async function processOneSafely(cp: MinutesCheckpoint, ctx: ManagerCtx, deps: MinutesDeps): Promise<ProcessOutcome> {
  try {
    return await processAuto(cp, ctx, deps);
  } catch (error) {
    if (error instanceof ConnectionChangedError) throw error;
    if (isGraphError(error) && (error.kind === "reauth" || error.kind === "config" || error.kind === "forbidden" || isInterruption(error))) {
      throw error;
    }
    await deps.minutes.recordSearch(cp.checkpointId, { status: "SEARCHING", error: errorCode(error) }, nowOf(deps));
    return "failed";
  }
}

// ── Acionamento manual (tela do Checkpoint; só o GESTOR do checkpoint) ──────

export type ManualResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: "not_found" | "forbidden" | "not_eligible" | "not_connected" | "busy" | "unavailable" | "reauth" };

function manualFailure<T>(result: ManagerRunResult<T>): ManualResult<T> {
  if (result.status === "ok") return { ok: true, value: result.value };
  if (result.status === "busy") return { ok: false, code: "busy" };
  if (result.status === "skipped") {
    if (result.reason === "not_manager") return { ok: false, code: "forbidden" };
    return { ok: false, code: "not_connected" };
  }
  if (result.status === "error" && result.code.startsWith("reauth")) return { ok: false, code: "reauth" };
  return { ok: false, code: "unavailable" };
}

async function loadOwnCheckpoint(
  checkpointId: string,
  actorUserId: string,
  deps: MinutesDeps,
): Promise<{ ok: true; cp: MinutesCheckpoint } | { ok: false; code: "not_found" | "forbidden" | "not_eligible" }> {
  const cp = await deps.minutes.getMinutesCheckpoint(checkpointId);
  if (!cp) return { ok: false, code: "not_found" };
  // Só o GESTOR do checkpoint aciona a leitura da PRÓPRIA caixa. Nem ADMIN/
  // PEOPLE disparam a leitura da caixa de outra pessoa.
  if (cp.managerUserId !== actorUserId) return { ok: false, code: "forbidden" };
  if (!isMinutesEligible(cp, nowOf(deps))) return { ok: false, code: "not_eligible" };
  return { ok: true, cp };
}

/** "Buscar ata no e-mail" (mesmo lease do job). */
export async function searchMinutesNow(
  checkpointId: string,
  actorUserId: string,
  deps: MinutesDeps,
): Promise<ManualResult<ProcessOutcome>> {
  const loaded = await loadOwnCheckpoint(checkpointId, actorUserId, deps);
  if (!loaded.ok) return loaded;
  const result = await withManagerConnection(actorUserId, deps, async (ctx) => {
    if (!managerMatches(loaded.cp, ctx)) return "not_eligible" as const;
    return processAuto(loaded.cp, ctx, deps);
  });
  return manualFailure(result);
}

export interface MinutesChoiceView {
  messageId: string;
  subject: string | null;
  receivedAt: string;
  fromName: string | null;
  fromEmail: string | null;
  webLink: string | null;
  hasAttachments: boolean;
}

/**
 * Candidatas para o gestor escolher (empate). Lidas AO VIVO da caixa dele e
 * devolvidas só para a tela — nada é persistido.
 */
export async function listMinutesChoices(
  checkpointId: string,
  actorUserId: string,
  deps: MinutesDeps,
): Promise<ManualResult<MinutesChoiceView[]>> {
  const loaded = await loadOwnCheckpoint(checkpointId, actorUserId, deps);
  if (!loaded.ok) return loaded;
  const result = await withManagerConnection(actorUserId, deps, async (ctx) => {
    if (!managerMatches(loaded.cp, ctx)) return [];
    const { candidates, selection } = await gatherCandidates(loaded.cp, ctx, deps, nowOf(deps));
    return rankCandidates(candidates, selection)
      .slice(0, 10)
      .map(({ candidate }) => ({
        messageId: candidate.messageId,
        subject: candidate.subject,
        receivedAt: candidate.receivedAt.toISOString(),
        fromName: candidate.fromName,
        fromEmail: candidate.fromEmail,
        webLink: candidate.webLink,
        hasAttachments: candidate.hasAttachments,
      }));
  });
  return manualFailure(result);
}

/**
 * O gestor escolheu uma mensagem: ela precisa continuar ELEGÍVEL para este
 * checkpoint (mesma regra da busca) — um id arbitrário é recusado.
 */
export async function chooseMinutesMessage(
  checkpointId: string,
  messageId: string,
  actorUserId: string,
  deps: MinutesDeps,
): Promise<ManualResult<ProcessOutcome>> {
  const loaded = await loadOwnCheckpoint(checkpointId, actorUserId, deps);
  if (!loaded.ok) return loaded;
  // Id fora do formato do Graph: recusado sem chamar o Graph.
  if (!isValidMessageId(messageId)) return { ok: true, value: "not_candidate" };
  const result = await withManagerConnection(actorUserId, deps, async (ctx): Promise<ProcessOutcome> => {
    if (!managerMatches(loaded.cp, ctx)) return "not_eligible";
    const now = nowOf(deps);
    let message;
    try {
      message = await ctx.graph.getMessage(messageId);
    } catch (error) {
      if (isGraphError(error) && error.kind === "not_found") return "not_candidate";
      throw error;
    }
    const candidate = toCandidate(message);
    if (!candidate) return "not_candidate";
    const consultantEmails = await deps.minutes.consultantEmails(loaded.cp.consultantId);
    const used = await deps.minutes.usedInternetMessageIds([candidate.internetMessageId.toLowerCase()], loaded.cp.checkpointId);
    const scored = scoreCandidate(candidate, selectionContext(loaded.cp, ctx, consultantEmails, used, now));
    if (!scored) return used.size > 0 ? "duplicate" : "not_candidate";
    return ingestCandidate(loaded.cp, candidate, ctx, deps, now);
  });
  return manualFailure(result);
}

