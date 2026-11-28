import type { AiTextProvider } from "@/lib/ai/provider";
import { CONTENT_TOO_LARGE, TRANSCRIPT_LIST_LIMIT, TRANSCRIPT_MAX_BYTES } from "../graph/client";
import { errorCode, isGraphError, isInterruption } from "../graph/errors";
import {
  renewManagerLease,
  runWithManagerConnection,
  type ManagerConnectionDeps,
  type ManagerCtx,
  type ManagerRunResult,
} from "../manager-connection";
import {
  buildMinutesPrompt,
  fallbackMinutesNotes,
  formatMinutesNotes,
  limitText,
  mapActionItems,
  minutesSystemPrompt,
  parseMinutes,
  type MinutesSourceMeta,
} from "../minutes/generate";
import { maskPii, unmaskDeep } from "../minutes/pii";
import { MIN_SOURCE_CHARS, type MaskedExtractionInput } from "../minutes/run";
import { ConnectionChangedError } from "../store";
import {
  TRANSCRIPT_LEASE_MS,
  accessBlocked,
  firstAttemptAt,
  planAfterMiss,
  transcriptEligibility,
  transcriptMode,
  type AttemptMiss,
  type TranscriptMode,
} from "./schedule";
import type { TranscriptCheckpoint, TranscriptStore } from "./store";
import { SPEAKER_TEXT_MARKER, SPEECH_MARKER, vttToSpeakerText } from "./vtt";

/**
 * Transcrição do Teams (M365 M3): orquestração com dependências injetadas
 * (store, Graph, IA, extração). Os testes usam store em memória, Graph fake e
 * IA mockada; nada aqui fala com a Microsoft diretamente.
 *
 * Invariantes:
 * - SÓ a conta do GESTOR do checkpoint (com os escopos do Teams), e só para
 *   reunião que ELE organizou (organizador do evento = caixa dele; e, quando o
 *   Graph informa, organizador da reunião online = o usuário dele). A conta do
 *   consultor nunca é usada.
 * - VTT só em memória → "Nome: fala" (parser linear) → MASCARAR → corte 70/30
 *   → IA (via `getAiTextProvider()`, injetado) → Zod → desmascarar em memória.
 *   Guardado: ata (notas), texto-fonte MASCARADO (transcription) e contadores.
 *   O VTT bruto nunca é persistido nem logado.
 * - Claim atômico do registro no banco + lease da conexão do gestor.
 * - Precedência: a transcrição gera a ata só se o rascunho ainda não tem
 *   conteúdo (o e-mail não chegou). Com ata/notas, só COMPLEMENTA, e só por
 *   ação do gestor (nunca pelo job).
 */

export interface TranscriptDeps extends ManagerConnectionDeps {
  transcripts: TranscriptStore;
  ai: AiTextProvider;
  /** Mesmo pipeline da M2 (Oportunidades/Cases/Skills), com texto MASCARADO + mapa. */
  runExtraction: (checkpointId: string, input: MaskedExtractionInput) => Promise<string>;
  /** Epoch ms: prazo da rodada. */
  deadline?: number;
  /** Teto TOTAL de bytes de VTT por reunião (todas as transcrições). */
  maxVttBytes?: number;
}

export type TranscriptOutcome =
  | "saved"
  | "saved_without_ai"
  | "waiting"
  | "no_transcript"
  | "access_denied"
  | "too_large"
  | "failed"
  | "checkpoint_changed"
  | "record_busy"
  | "not_eligible"
  | "already_done";

/** Separador do complemento nas notas (ata por e-mail/gestor + Teams). */
export const SUPPLEMENT_NOTES_HEADER = "──────── Complemento: transcrição do Teams ────────";
export const SUPPLEMENT_SOURCE_HEADER = "=== Transcrição do Teams (dados pessoais mascarados) ===";

function nowOf(deps: TranscriptDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

type Fetched =
  | { kind: "text"; text: string; transcripts: number; truncated: boolean; utterances: number; speakers: number }
  | { kind: "miss"; miss: AttemptMiss };

/** Erro que é da CONEXÃO (sobe e encerra a rodada do gestor). */
function isConnectionError(error: unknown): boolean {
  if (error instanceof ConnectionChangedError) return true;
  return isGraphError(error) && (error.kind === "reauth" || error.kind === "config" || isInterruption(error));
}

/**
 * Busca a transcrição da reunião do gestor: reunião pelo link → transcrições
 * → conteúdo VTT (só em memória, teto total de bytes).
 */
async function fetchTranscript(cp: TranscriptCheckpoint, ctx: ManagerCtx, deps: TranscriptDeps): Promise<Fetched> {
  try {
    const meeting = await ctx.graph.findOnlineMeetingByJoinUrl(cp.eventJoinUrl ?? "");
    if (!meeting) return { kind: "miss", miss: { kind: "no_meeting" } };
    const graphUserId = ctx.connection.graphUserId ?? null;
    if (meeting.organizerId && graphUserId && meeting.organizerId !== graphUserId) {
      return { kind: "miss", miss: { kind: "not_organizer" } };
    }
    const list = (await ctx.graph.listTranscripts(meeting.id))
      .slice()
      .sort((a, b) => (Date.parse(a.createdDateTime ?? "") || 0) - (Date.parse(b.createdDateTime ?? "") || 0))
      .slice(0, TRANSCRIPT_LIST_LIMIT);
    if (list.length === 0) return { kind: "miss", miss: { kind: "no_transcript" } };
    const maxBytes = deps.maxVttBytes ?? TRANSCRIPT_MAX_BYTES;
    let used = 0;
    const vtts: string[] = [];
    for (const t of list) {
      const remaining = maxBytes - used;
      if (remaining <= 0) return { kind: "miss", miss: { kind: "too_large" } };
      const content = await ctx.graph.getTranscriptContent(meeting.id, t.id, remaining);
      used += Buffer.byteLength(content, "utf8");
      vtts.push(content);
    }
    const speaker = vttToSpeakerText(vtts);
    vtts.length = 0;
    // Marcadores de corte não contam como conteúdo: só "marcador" nunca vira ata.
    const content = speaker.text.split(SPEAKER_TEXT_MARKER).join("").split(SPEECH_MARKER).join("");
    let chars = 0;
    for (let i = 0; i < content.length; i += 1) if (content.charCodeAt(i) > 0x20) chars += 1;
    if (chars < MIN_SOURCE_CHARS) return { kind: "miss", miss: { kind: "empty_transcript" } };
    return { kind: "text", text: speaker.text, transcripts: list.length, truncated: speaker.truncated, utterances: speaker.utterances, speakers: speaker.speakers };
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (isGraphError(error) && error.kind === "forbidden") return { kind: "miss", miss: { kind: "forbidden" } };
    if (isGraphError(error) && error.code === CONTENT_TOO_LARGE) return { kind: "miss", miss: { kind: "too_large" } };
    if (isGraphError(error) && error.kind === "not_found") return { kind: "miss", miss: { kind: "no_transcript" } };
    return { kind: "miss", miss: { kind: "transient", code: errorCode(error) } };
  }
}

function manualOutcomeForMiss(miss: AttemptMiss): TranscriptOutcome {
  if (miss.kind === "forbidden") return "access_denied";
  if (miss.kind === "too_large") return "too_large";
  if (miss.kind === "transient") return "failed";
  if (miss.kind === "not_organizer" || miss.kind === "superseded") return "not_eligible";
  return "no_transcript";
}

/** Fecha a tentativa sem ata (estado + próxima tentativa) e avisa se final. */
async function closeMiss(
  cp: TranscriptCheckpoint,
  miss: AttemptMiss,
  deps: TranscriptDeps,
  manual: boolean,
): Promise<TranscriptOutcome> {
  const now = nowOf(deps);
  const plan = planAfterMiss(miss, { endAt: cp.eventEndAt, now, misses: (cp.transcript?.attempts ?? 0) + 1 });
  const recorded = await deps.transcripts.recordAttempt(
    cp.checkpointId,
    deps.owner,
    { status: plan.status, nextAttemptAt: plan.nextAttemptAt, error: plan.error, accessDeniedAt: plan.accessDeniedAt },
    now,
  );
  // Aviso só do JOB, ao entrar num estado final sem ata (o manual responde na tela).
  if (recorded && plan.notify && !manual && cp.managerUserId) {
    await deps.transcripts.notifyManager({ userId: cp.managerUserId, checkpointId: cp.checkpointId, kind: "missing" });
  }
  await deps.store.logIntegrationEvent({
    operation: "transcript.attempt",
    status: plan.status === "FAILED" ? "FAILED" : "SUCCESS",
    entityType: "Checkpoint",
    entityId: cp.checkpointId,
    meta: { result: miss.kind, status: plan.status, manual },
    error: plan.status === "FAILED" ? plan.error : null,
  });
  if (manual) return manualOutcomeForMiss(miss);
  return plan.status === "WAITING_TRANSCRIPT" ? "waiting" : plan.status === "NO_TRANSCRIPT" ? "no_transcript" : "failed";
}

/** Gera a ata a partir do texto "Nome: fala" (mascara antes da IA) e grava. */
async function generateAndSave(
  cp: TranscriptCheckpoint,
  fetched: Extract<Fetched, { kind: "text" }>,
  mode: TranscriptMode,
  deps: TranscriptDeps,
  manual: boolean,
): Promise<TranscriptOutcome> {
  const now = nowOf(deps);
  // MASCARAR antes de cortar e antes de qualquer chamada à IA. Mapa só em memória.
  const { masked: maskedFull, map } = maskPii(fetched.text);
  const limited = limitText(maskedFull);
  const masked = limited.text;
  const meta: MinutesSourceMeta = {
    kind: "teams",
    receivedAt: cp.eventEndAt,
    attachmentsUsed: 0,
    attachmentsSkipped: 0,
    truncated: limited.truncated || fetched.truncated,
  };
  const raw = await deps.ai.complete(
    buildMinutesPrompt({ maskedSource: masked, type: cp.type, truncated: meta.truncated, kind: "teams" }),
    { system: minutesSystemPrompt("teams"), json: true, maxTokens: 2500, entityType: "Checkpoint", entityId: cp.checkpointId },
  );
  const parsed = parseMinutes(raw);
  const aiSummary = parsed.ok;
  const maskedNewNotes = parsed.ok ? formatMinutesNotes(parsed.data, meta) : fallbackMinutesNotes(meta);
  // Ata e cards DESMASCARADOS em memória; o texto-fonte guardado fica mascarado.
  const readable = parsed.ok ? unmaskDeep(parsed.data, map) : null;
  const newNotes = readable ? formatMinutesNotes(readable, meta) : maskedNewNotes;

  let notes = newNotes;
  let transcription = masked;
  let maskedNotesForExtraction = maskedNewNotes;
  if (mode === "SUPPLEMENT") {
    const existingNotes = (cp.notes ?? "").trim();
    const existingSource = (cp.transcription ?? "").trim();
    notes = existingNotes ? `${existingNotes}\n\n${SUPPLEMENT_NOTES_HEADER}\n\n${newNotes}` : newNotes;
    transcription = existingSource ? `${existingSource}\n\n${SUPPLEMENT_SOURCE_HEADER}\n${masked}` : masked;
    maskedNotesForExtraction = existingNotes
      ? `${maskPii(existingNotes, map).masked}\n\n${SUPPLEMENT_NOTES_HEADER}\n\n${maskedNewNotes}`
      : maskedNewNotes;
  }
  const actionItems = readable ? mapActionItems(readable) : [];
  const saved = await deps.transcripts.saveTranscriptMinutes({
    checkpointId: cp.checkpointId,
    owner: deps.owner,
    mode,
    expected: { checkpointStatus: cp.checkpointStatus, notes: cp.notes, transcription: cp.transcription },
    notes,
    transcription,
    aiSummary,
    transcriptsUsed: fetched.transcripts,
    truncated: meta.truncated,
    actionItems,
    now,
  });
  if (saved === "lease_lost") return "record_busy";
  if (saved === "checkpoint_changed") {
    // O gestor (ou a ata por e-mail) mudou o checkpoint durante a geração:
    // nada é sobrescrito; o job para e o gestor pode complementar.
    await deps.transcripts.recordAttempt(
      cp.checkpointId,
      deps.owner,
      { status: "FAILED", nextAttemptAt: null, error: "checkpoint_changed" },
      now,
    );
    return "checkpoint_changed";
  }

  let extraction = "skipped";
  if (aiSummary) {
    try {
      extraction = await deps.runExtraction(cp.checkpointId, {
        maskedNotes: maskedNotesForExtraction,
        // Re-mascarar é idempotente nos marcadores e cobre texto que o gestor
        // tenha colado na transcrição existente.
        maskedTranscription: mode === "SUPPLEMENT" ? maskPii(transcription, map).masked : masked,
        piiMap: map,
      });
    } catch {
      extraction = "failed";
    }
  }
  if (cp.managerUserId) {
    await deps.transcripts.notifyManager({ userId: cp.managerUserId, checkpointId: cp.checkpointId, kind: "ready" });
  }
  await deps.store.logIntegrationEvent({
    operation: "transcript.ingest",
    status: "SUCCESS",
    entityType: "Checkpoint",
    entityId: cp.checkpointId,
    meta: {
      mode,
      manual,
      aiSummary,
      aiError: parsed.ok ? null : parsed.reason,
      transcripts: fetched.transcripts,
      utterances: fetched.utterances,
      speakers: fetched.speakers,
      truncated: meta.truncated,
      actionItems: actionItems.length,
      extraction,
    },
  });
  return aiSummary ? "saved" : "saved_without_ai";
}

/**
 * Uma tentativa sob o claim do registro: busca → (sem transcrição: agenda a
 * próxima) | (com transcrição: GENERATING → gera → DONE).
 */
async function attempt(
  cp: TranscriptCheckpoint,
  ctx: ManagerCtx,
  deps: TranscriptDeps,
  mode: TranscriptMode,
  manual: boolean,
): Promise<TranscriptOutcome> {
  const now = nowOf(deps);
  // 403 recente: nenhuma consulta (job ou botão) por 24 h a partir dele.
  if (accessBlocked(cp.transcript?.accessDeniedAt, now)) return "access_denied";
  const until = new Date(now.getTime() + TRANSCRIPT_LEASE_MS);
  if (!(await deps.transcripts.claim(cp.checkpointId, deps.owner, until, now, manual))) return "record_busy";
  try {
    const fetched = await fetchTranscript(cp, ctx, deps);
    if (fetched.kind === "miss") return await closeMiss(cp, fetched.miss, deps, manual);
    // Heartbeat da conexão ANTES de entrar em GENERATING (lease perdido aqui
    // encerra sem mudar o estado do registro).
    await renewManagerLease(deps, ctx.connection.id);
    if (!(await deps.transcripts.markGenerating(cp.checkpointId, deps.owner, new Date(nowOf(deps).getTime() + TRANSCRIPT_LEASE_MS)))) {
      return "record_busy";
    }
    try {
      return await generateAndSave(cp, fetched, mode, deps, manual);
    } catch (error) {
      if (isConnectionError(error)) throw error;
      // Falha da geração (IA lançou, banco…): volta a esperar com backoff.
      return await closeMiss(cp, { kind: "transient", code: errorCode(error) }, deps, manual);
    }
  } finally {
    // SEMPRE: se ainda é dono e o registro ficou em GENERATING (interrupção,
    // erro da conexão, lease perdido), volta a WAITING_TRANSCRIPT com backoff
    // (ou FAILED fora de 48 h). Depois solta o lease. Nunca GENERATING órfão.
    const at = nowOf(deps);
    const plan = planAfterMiss(
      { kind: "transient", code: "interrupted" },
      { endAt: cp.eventEndAt, now: at, misses: (cp.transcript?.attempts ?? 0) + 1 },
    );
    await deps.transcripts.releaseClaim(
      cp.checkpointId,
      deps.owner,
      {
        status: plan.status === "FAILED" ? "FAILED" : "WAITING_TRANSCRIPT",
        nextAttemptAt: plan.nextAttemptAt,
        error: "interrupted",
      },
      at,
    );
  }
}

/** O gestor da conta é o do checkpoint e não é o próprio consultor. */
function managerMatches(cp: TranscriptCheckpoint, ctx: ManagerCtx): boolean {
  return cp.managerUserId === ctx.user.user.id && ctx.user.consultantId !== cp.consultantId;
}

export interface TranscriptJobSummary {
  expired: number;
  enrolled: number;
  checkpoints: number;
  managers: number;
  saved: number;
  waiting: number;
  noTranscript: number;
  failed: number;
  busy: number;
  skipped: number;
  errors: number;
}

/** Job: cria PENDING dos novos e processa os devidos, por conta do gestor. */
export async function runTranscriptRound(deps: TranscriptDeps, limit = 50): Promise<TranscriptJobSummary> {
  const summary: TranscriptJobSummary = {
    expired: 0,
    enrolled: 0,
    checkpoints: 0,
    managers: 0,
    saved: 0,
    waiting: 0,
    noTranscript: 0,
    failed: 0,
    busy: 0,
    skipped: 0,
    errors: 0,
  };
  const now = nowOf(deps);
  // Nenhum estado sem saída: não finais fora da janela de 48 h → NO_TRANSCRIPT.
  summary.expired = await deps.transcripts.expireStale(now);
  summary.enrolled = await deps.transcripts.enrollDueCheckpoints(now, limit);
  const due = await deps.transcripts.listDue(now, limit);
  const byManager = new Map<string, TranscriptCheckpoint[]>();
  for (const cp of due) {
    if (!cp.managerUserId) continue;
    const list = byManager.get(cp.managerUserId) ?? [];
    list.push(cp);
    byManager.set(cp.managerUserId, list);
  }
  const expired = () => deps.deadline !== undefined && Date.now() >= deps.deadline;
  for (const [managerUserId, list] of byManager) {
    if (expired()) break;
    summary.managers += 1;
    const connectionId = await deps.transcripts.connectionIdForUser(managerUserId);
    const result = await runWithManagerConnection(
      managerUserId,
      connectionId,
      deps,
      { capability: "TEAMS", logOperation: "transcript.teams" },
      async (ctx) => {
        for (const cp of list) {
          if (expired()) break;
          await renewManagerLease(deps, ctx.connection.id);
          summary.checkpoints += 1;
          const outcome = await processDue(cp, ctx, deps);
          if (outcome === "saved" || outcome === "saved_without_ai") summary.saved += 1;
          else if (outcome === "waiting") summary.waiting += 1;
          else if (outcome === "no_transcript") summary.noTranscript += 1;
          else if (outcome === "failed" || outcome === "checkpoint_changed") summary.failed += 1;
          else summary.skipped += 1;
        }
      },
    );
    if (result.status === "busy") summary.busy += 1;
    else if (result.status === "error") summary.errors += 1;
    else if (result.status === "skipped" || result.status === "interrupted") summary.skipped += 1;
  }
  return summary;
}

/** Um registro devido no job: elegibilidade, precedência e tentativa. */
async function processDue(cp: TranscriptCheckpoint, ctx: ManagerCtx, deps: TranscriptDeps): Promise<TranscriptOutcome> {
  if (!managerMatches(cp, ctx)) return "not_eligible";
  const now = nowOf(deps);
  const eligibility = transcriptEligibility(cp, ctx.managerEmails, now);
  if (eligibility === "too_early") return "not_eligible";
  if (eligibility !== "ok" || transcriptMode(cp) === "SUPPLEMENT") {
    // Cancelado/arquivado/fora da janela/não organizado pelo gestor, ou o
    // checkpoint já tem ata (e-mail chegou antes): o job encerra o registro.
    const miss: AttemptMiss =
      eligibility === "not_organizer"
        ? { kind: "not_organizer" }
        : eligibility === "too_late"
          ? { kind: "no_transcript" }
          : { kind: "superseded" };
    if (!(await deps.transcripts.claim(cp.checkpointId, deps.owner, new Date(now.getTime() + TRANSCRIPT_LEASE_MS), now, false))) {
      return "record_busy";
    }
    try {
      await closeMiss(cp, miss, deps, false);
    } finally {
      await deps.transcripts.releaseClaim(
        cp.checkpointId,
        deps.owner,
        { status: "FAILED", nextAttemptAt: null, error: "interrupted" },
        nowOf(deps),
      );
    }
    return "not_eligible";
  }
  return attempt(cp, ctx, deps, "GENERATE", false);
}

// ── Acionamento manual (tela do Checkpoint; só o GESTOR do checkpoint) ──────

export type TranscriptManualResult =
  | { ok: true; value: TranscriptOutcome }
  | { ok: false; code: "not_found" | "forbidden" | "not_eligible" | "too_early" | "not_connected" | "busy" | "unavailable" | "reauth" };

function manualFailure(result: ManagerRunResult<TranscriptOutcome>): TranscriptManualResult {
  if (result.status === "ok") return { ok: true, value: result.value };
  if (result.status === "busy") return { ok: false, code: "busy" };
  if (result.status === "skipped") {
    if (result.reason === "not_manager") return { ok: false, code: "forbidden" };
    return { ok: false, code: "not_connected" };
  }
  if (result.status === "error" && result.code.startsWith("reauth")) return { ok: false, code: "reauth" };
  return { ok: false, code: "unavailable" };
}

/**
 * "Buscar transcrição do Teams" / "Complementar com a transcrição do Teams":
 * só o GESTOR do checkpoint, na PRÓPRIA conta, até 48 h após o fim. Rascunho
 * sem conteúdo → gera a ata; com ata/notas → complementa (nunca sobrescreve).
 */
export async function fetchTranscriptNow(
  checkpointId: string,
  actorUserId: string,
  deps: TranscriptDeps,
): Promise<TranscriptManualResult> {
  const cp = await deps.transcripts.getTranscriptCheckpoint(checkpointId);
  if (!cp) return { ok: false, code: "not_found" };
  // Nem ADMIN/PEOPLE usam a conta de outra pessoa.
  if (cp.managerUserId !== actorUserId) return { ok: false, code: "forbidden" };
  if (cp.transcript?.status === "DONE") return { ok: true, value: "already_done" };
  const connectionId = await deps.transcripts.connectionIdForUser(actorUserId);
  let early = false;
  const result = await runWithManagerConnection(
    actorUserId,
    connectionId,
    deps,
    { capability: "TEAMS", logOperation: "transcript.teams" },
    async (ctx): Promise<TranscriptOutcome> => {
      if (!managerMatches(cp, ctx)) return "not_eligible";
      const now = nowOf(deps);
      const eligibility = transcriptEligibility(cp, ctx.managerEmails, now);
      if (eligibility === "too_early") {
        early = true;
        return "not_eligible";
      }
      if (eligibility !== "ok") return "not_eligible";
      // 403 recente: respeita as 24 h sem nova consulta (nem pelo botão).
      if (accessBlocked(cp.transcript?.accessDeniedAt, now)) return "access_denied";
      await deps.transcripts.ensureRecord(cp.checkpointId, firstAttemptAt(cp.eventEndAt));
      return attempt(cp, ctx, deps, transcriptMode(cp), true);
    },
  );
  if (early) return { ok: false, code: "too_early" };
  return manualFailure(result);
}
