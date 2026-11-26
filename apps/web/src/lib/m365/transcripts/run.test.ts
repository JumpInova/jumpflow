import { describe, expect, it, vi } from "vitest";
import type { AiTextProvider } from "@/lib/ai/provider";
import { createFakeGraphClient, type FakeGraph } from "../graph/fake";
import { GraphError } from "../graph/errors";
import { runMinutesRound, type MinutesDeps } from "../minutes/run";
import type { MinutesCheckpoint } from "../minutes/store";
import type { M365ConnectionRecord } from "../store";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { createMemoryMinutesStore } from "../testing/memory-minutes-store";
import { createMemoryTranscriptStore } from "../testing/memory-transcript-store";
import {
  SUPPLEMENT_NOTES_HEADER,
  SUPPLEMENT_SOURCE_HEADER,
  fetchTranscriptNow,
  runTranscriptRound,
  type TranscriptDeps,
} from "./run";
import type { TranscriptCheckpoint } from "./store";

const MIN = 60_000;
const HOUR = 60 * MIN;
const END = new Date("2026-11-26T14:00:00.000Z");
const at = (ms: number) => new Date(END.getTime() + ms);
const JOIN = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d";
const BASE = ["openid", "profile", "offline_access", "User.Read", "Calendars.Read"];
const TEAMS = [...BASE, "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"];
const TEAMS_AND_MAIL = [...TEAMS, "Mail.Read"];

const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000",
  "<v Gestor Silva>Vamos revisar o projeto. Meu e-mail é gestor.pessoal@gmail.com.</v>",
  "",
  "2",
  "00:00:05.000 --> 00:00:09.000",
  "<v Ana Souza>Combinado. Meu CPF é 123.456.789-09 e o telefone (11) 98765-4321.</v>",
  "",
  "3",
  "00:00:10.000 --> 00:00:15.000",
  "<v Gestor Silva>Ana envia o plano de estudos até 2026-12-05.</v>",
].join("\n");

const AI_OK = JSON.stringify({
  summary: "Revisão do projeto com contato [EMAIL_1].",
  decisions: ["Manter a alocação"],
  attentionPoints: [],
  actions: [{ title: "Enviar plano de estudos", owner: "Ana", dueDate: "2026-12-05", quote: "Ana envia o plano até 2026-12-05" }],
});

function cp(o: Partial<Omit<TranscriptCheckpoint, "transcript">> = {}): Omit<TranscriptCheckpoint, "transcript"> {
  return {
    checkpointId: "chk1",
    managerUserId: "u-mgr",
    consultantId: "cons-ana",
    type: "ONE_ON_ONE",
    checkpointStatus: "DRAFT",
    notes: null,
    transcription: null,
    audioStorageKey: null,
    occurredAt: at(-HOUR),
    eventJoinUrl: JOIN,
    eventOrganizerEmail: "gestor@jump.com.br",
    eventStartAt: at(-HOUR),
    eventEndAt: END,
    eventCancelled: false,
    emailMinutesStatus: null,
    ...o,
  };
}

function setup(opts: { now?: Date; aiResponse?: string | null; mgrScopes?: string[]; withTranscript?: boolean } = {}) {
  let now = opts.now ?? at(15 * MIN);
  const { store, state } = createMemoryStore();
  state.users.set("u-mgr", {
    user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] },
    consultantId: null,
  });
  state.users.set("u-ana", {
    user: { id: "u-ana", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] },
    consultantId: "cons-ana",
  });
  state.users.set("u-admin", {
    user: { id: "u-admin", name: "Admin", email: "admin@jump.com.br", roles: ["ADMIN"] },
    consultantId: null,
  });
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br", graphUserId: "g-mgr", scopes: opts.mgrScopes ?? TEAMS });
  // O consultor também conectou E consentiu Teams: mesmo assim nunca é usado.
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br", graphUserId: "g-ana", scopes: TEAMS });
  addConnection(state, { id: "c-admin", userId: "u-admin", mailbox: "admin@jump.com.br", graphUserId: "g-admin", scopes: TEAMS });

  const { transcripts, state: tstate } = createMemoryTranscriptStore();
  tstate.connectionsByUser.set("u-mgr", "c-mgr");
  tstate.connectionsByUser.set("u-ana", "c-ana");
  tstate.connectionsByUser.set("u-admin", "c-admin");
  tstate.teamsUsers.add("u-mgr");
  tstate.checkpoints.set("chk1", cp());

  const graphs: Record<string, FakeGraph> = {
    "c-mgr": createFakeGraphClient(),
    "c-ana": createFakeGraphClient(),
    "c-admin": createFakeGraphClient(),
  };
  graphs["c-mgr"].addOnlineMeeting({
    id: "meet-1",
    joinWebUrl: JOIN,
    organizerId: "g-mgr",
    transcripts: opts.withTranscript === false ? [] : [{ id: "tr-1", createdDateTime: "2026-11-26T14:01:00Z", content: VTT }],
  });
  // A mesma reunião vista pela conta do consultor (nunca deve ser consultada).
  graphs["c-ana"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-mgr", transcripts: [{ id: "tr-1", content: VTT }] });

  const ai = {
    complete: vi.fn(async () => (opts.aiResponse === undefined ? AI_OK : opts.aiResponse)),
    completeWithDocument: vi.fn(async () => null),
  } satisfies AiTextProvider;
  const runExtraction = vi.fn(async () => "done");
  const deps: TranscriptDeps = {
    store,
    transcripts,
    graphFor: (c: M365ConnectionRecord) => graphs[c.id],
    ai,
    runExtraction,
    owner: "job-A",
    now: () => now,
  };
  return {
    store,
    state,
    transcripts,
    tstate,
    graphs,
    ai,
    runExtraction,
    deps,
    setNow: (d: Date) => {
      now = d;
    },
  };
}

const record = (s: ReturnType<typeof setup>) => s.tstate.records.get("chk1");
const checkpoint = (s: ReturnType<typeof setup>) => s.tstate.checkpoints.get("chk1")!;
const consultantUntouched = (s: ReturnType<typeof setup>) => {
  expect(s.graphs["c-ana"].calls.teams).toEqual([]);
  expect(s.graphs["c-admin"].calls.teams).toEqual([]);
};

describe("job — transcrição → ata (GENERATE)", () => {
  it("PENDING → GENERATING → DONE: ata desmascarada, fonte MASCARADA, RECORDED, cards, extração e aviso", async () => {
    const s = setup();
    const summary = await runTranscriptRound(s.deps);
    expect(summary).toMatchObject({ enrolled: 1, saved: 1 });
    expect(record(s)).toMatchObject({ status: "DONE", mode: "GENERATE", aiSummary: true, leaseOwner: null });
    const c = checkpoint(s);
    expect(c.checkpointStatus).toBe("RECORDED");
    expect(c.notes).toContain("Ata gerada por IA a partir da transcrição do Teams");
    expect(c.notes).toContain("gestor.pessoal@gmail.com"); // desmascarado em memória
    expect(c.transcription).toContain("Ana Souza: Combinado.");
    for (const raw of ["gestor.pessoal@gmail.com", "123.456.789-09", "98765-4321"]) expect(c.transcription).not.toContain(raw);
    expect(c.transcription).not.toContain("WEBVTT");
    expect(c.transcription).not.toContain("-->");
    expect(s.tstate.actionItems).toHaveLength(1);
    expect(s.tstate.actionItems[0]).toMatchObject({ title: "Enviar plano de estudos", status: "PENDING" });
    expect(s.runExtraction).toHaveBeenCalledTimes(1);
    expect(s.tstate.notifications).toEqual([{ userId: "u-mgr", checkpointId: "chk1", kind: "ready" }]);
    // Fluxo de chamadas: reunião pelo link → transcrições → conteúdo, só na conta do gestor.
    expect(s.graphs["c-mgr"].calls.teams.map((c) => c.op)).toEqual(["meeting", "transcripts", "content"]);
    expect(s.graphs["c-mgr"].calls.teams[0].joinUrl).toBe(JOIN);
    consultantUntouched(s);
  });

  it("mascara ANTES da IA: prompt e system sem e-mail/CPF/telefone; extração recebe texto mascarado + mapa", async () => {
    const s = setup();
    await runTranscriptRound(s.deps);
    const [prompt, options] = s.ai.complete.mock.calls[0] as unknown as [string, { system: string; json: boolean }];
    for (const raw of ["gestor.pessoal@gmail.com", "123.456.789-09", "98765-4321", "WEBVTT", "-->"]) {
      expect(prompt).not.toContain(raw);
      expect(options.system).not.toContain(raw);
    }
    expect(prompt).toContain("[EMAIL_1]");
    expect(prompt).toContain("[CPF_1]");
    expect(prompt).toContain("=== TRANSCRIÇÃO ===");
    expect(options.json).toBe(true);
    const [, input] = s.runExtraction.mock.calls[0] as unknown as [string, { maskedNotes: string; maskedTranscription: string; piiMap: { byToken: Map<string, string> } }];
    expect(input.maskedNotes).not.toContain("gestor.pessoal@gmail.com");
    expect(input.maskedTranscription).not.toContain("123.456.789-09");
    expect(input.piiMap.byToken.get("[EMAIL_1]")).toBe("gestor.pessoal@gmail.com");
  });

  it("logs/IntegrationEvent só com contadores: sem nomes, falas, e-mails ou VTT", async () => {
    const s = setup();
    await runTranscriptRound(s.deps);
    const dump = JSON.stringify(s.state.logs);
    for (const banned of ["Ana Souza", "Gestor Silva", "gestor.pessoal", "123.456", "WEBVTT", "plano de estudos", JOIN]) {
      expect(dump).not.toContain(banned);
    }
    expect(s.state.logs.find((l) => l.operation === "transcript.ingest")?.meta).toMatchObject({ speakers: 2, transcripts: 1 });
  });

  it("IA indisponível (null) → fonte mascarada + nota de origem, RECORDED, sem cards nem extração", async () => {
    const s = setup({ aiResponse: null });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE", aiSummary: false });
    expect(checkpoint(s).notes).toContain("Transcrição do Teams importada sem resumo");
    expect(s.tstate.actionItems).toEqual([]);
    expect(s.runExtraction).not.toHaveBeenCalled();
  });
});

describe("só a conta do GESTOR organizador", () => {
  it("reunião organizada pelo consultor (organizador ≠ caixa do gestor) → FAILED not_organizer, nada lido", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ eventOrganizerEmail: "ana@jump.com.br" }));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "not_organizer" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(s.tstate.notifications).toEqual([]);
    consultantUntouched(s);
  });

  it("organizador da reunião online (Graph) é outro usuário → FAILED not_organizer, sem baixar conteúdo", async () => {
    const s = setup();
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-outro", transcripts: [{ id: "tr-1", content: VTT }] });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "not_organizer" });
    expect(s.graphs["c-mgr"].calls.teams.map((c) => c.op)).toEqual(["meeting"]);
    expect(s.ai.complete).not.toHaveBeenCalled();
  });

  it("gestor sem os escopos do Teams: nada é enrolado nem lido (mesmo com o consultor tendo Teams)", async () => {
    const s = setup({ mgrScopes: BASE });
    s.tstate.teamsUsers.delete("u-mgr");
    s.tstate.teamsUsers.add("u-ana");
    expect(await runTranscriptRound(s.deps)).toMatchObject({ enrolled: 0, saved: 0 });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    consultantUntouched(s);
  });

  it("checkpoint cujo 'gestor' é o próprio consultor → ignorado (conta do consultor nunca alimenta ata)", async () => {
    const s = setup();
    s.state.users.set("u-mgr", {
      user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] },
      consultantId: "cons-ana",
    });
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(checkpoint(s).notes).toBeNull();
  });

  it("manual: só o gestor do checkpoint (ADMIN e o consultor → forbidden, sem lease nem chamada)", async () => {
    const s = setup();
    expect(await fetchTranscriptNow("chk1", "u-admin", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await fetchTranscriptNow("chk1", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await fetchTranscriptNow("nope", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_found" });
    expect(s.state.connections.get("c-admin")!.leaseOwner).toBeNull();
    consultantUntouched(s);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });
});

describe("backoff, 403 e sem transcrição", () => {
  it("sem transcrição: WAITING com backoff; fora da hora não consulta; transcrição chega depois → DONE", async () => {
    const s = setup({ withTranscript: false });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "WAITING_TRANSCRIPT", attempts: 1, nextAttemptAt: at(30 * MIN) });
    s.setNow(at(29 * MIN));
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams.filter((c) => c.op === "meeting")).toHaveLength(1);
    s.graphs["c-mgr"].addTranscript("meet-1", { id: "tr-1", content: VTT });
    s.setNow(at(30 * MIN));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
    expect(checkpoint(s).checkpointStatus).toBe("RECORDED");
  });

  it("6 h sem transcrição → NO_TRANSCRIPT e UM aviso ao gestor (colar notas / aguardar e-mail)", async () => {
    const s = setup({ withTranscript: false });
    let now = at(10 * MIN);
    s.setNow(now);
    for (let i = 0; i < 20; i += 1) {
      await runTranscriptRound(s.deps);
      const rec = record(s)!;
      if (rec.status !== "WAITING_TRANSCRIPT") break;
      now = rec.nextAttemptAt!;
      s.setNow(now);
    }
    expect(record(s)).toMatchObject({ status: "NO_TRANSCRIPT" });
    expect(now).toEqual(at(6 * HOUR));
    expect(s.tstate.notifications).toEqual([{ userId: "u-mgr", checkpointId: "chk1", kind: "missing" }]);
    s.setNow(at(7 * HOUR));
    await runTranscriptRound(s.deps);
    expect(s.tstate.notifications).toHaveLength(1);
  });

  it("403 → acesso negado: nenhuma nova consulta por 24 h", async () => {
    const s = setup();
    s.graphs["c-mgr"].failNext(new GraphError("forbidden", "Graph respondeu 403.", { status: 403 }));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "WAITING_TRANSCRIPT", lastError: "access_denied", nextAttemptAt: at(15 * MIN + 24 * HOUR) });
    for (const t of [HOUR, 6 * HOUR, 20 * HOUR]) {
      s.setNow(at(t));
      await runTranscriptRound(s.deps);
    }
    expect(s.graphs["c-mgr"].calls.teams).toHaveLength(0);
    // Nem o botão do gestor consulta antes das 24 h.
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
    expect(s.graphs["c-mgr"].calls.teams).toHaveLength(0);
    // Conexão continua ACTIVE (403 é da reunião, não da conta).
    expect(s.state.connections.get("c-mgr")!.status).toBe("ACTIVE");
    s.setNow(at(15 * MIN + 24 * HOUR));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("transcrição acima do teto de bytes → FAILED transcript_too_large + aviso, nada enviado à IA", async () => {
    const s = setup();
    s.deps.maxVttBytes = 50;
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "transcript_too_large" });
    expect(s.ai.complete).not.toHaveBeenCalled();
    expect(s.tstate.notifications.map((n) => n.kind)).toEqual(["missing"]);
  });

  it("reauth na conta do gestor → conexão REAUTH_REQUIRED, registro intacto para a próxima rodada", async () => {
    const s = setup();
    s.graphs["c-mgr"].failNext(new GraphError("reauth", "401", { status: 401 }));
    expect(await runTranscriptRound(s.deps)).toMatchObject({ errors: 1 });
    expect(s.state.connections.get("c-mgr")!.status).toBe("REAUTH_REQUIRED");
    expect(record(s)).toMatchObject({ status: "PENDING", attempts: 0, leaseOwner: null });
  });
});

describe("precedência sobre o e-mail", () => {
  it("ata por e-mail já gravada (RECORDED) → o job não enrola nem lê; manual COMPLEMENTA sem sobrescrever", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "RECORDED", notes: "Ata do e-mail", transcription: "Corpo do e-mail: [EMAIL_1]", emailMinutesStatus: "DONE" }));
    expect(await runTranscriptRound(s.deps)).toMatchObject({ enrolled: 0, saved: 0 });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);

    const r = await fetchTranscriptNow("chk1", "u-mgr", s.deps);
    expect(r).toEqual({ ok: true, value: "saved" });
    const c = checkpoint(s);
    expect(c.checkpointStatus).toBe("RECORDED");
    expect(c.notes!.startsWith("Ata do e-mail\n\n" + SUPPLEMENT_NOTES_HEADER)).toBe(true);
    expect(c.notes).toContain("transcrição do Teams");
    expect(c.transcription!.startsWith("Corpo do e-mail: [EMAIL_1]\n\n" + SUPPLEMENT_SOURCE_HEADER)).toBe(true);
    expect(c.transcription).not.toContain("123.456.789-09");
    expect(record(s)).toMatchObject({ status: "DONE", mode: "SUPPLEMENT" });
  });

  it("e-mail chegou depois do enrolamento → o job encerra o registro (superseded) sem ler o Teams", async () => {
    const s = setup({ now: at(5 * MIN) });
    await runTranscriptRound(s.deps); // enrola PENDING (ainda cedo para consultar)
    expect(record(s)).toMatchObject({ status: "PENDING" });
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "RECORDED", notes: "Ata do e-mail", transcription: "fonte" }));
    s.setNow(at(15 * MIN));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "superseded" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(checkpoint(s).notes).toBe("Ata do e-mail");
  });

  it("checkpoint muda durante a IA (ata por e-mail/gestor) → nada sobrescrito, FAILED checkpoint_changed", async () => {
    const s = setup();
    s.ai.complete.mockImplementationOnce(async () => {
      const current = s.tstate.checkpoints.get("chk1")!;
      current.notes = "o gestor escreveu";
      return AI_OK;
    });
    await runTranscriptRound(s.deps);
    expect(checkpoint(s).notes).toBe("o gestor escreveu");
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "checkpoint_changed" });
    expect(s.tstate.actionItems).toEqual([]);
  });

  it("job de atas por e-mail ESPERA a transcrição (Teams ativo, reunião do gestor, < 1 h; ou GENERATING)", async () => {
    const { store, state } = createMemoryStore();
    state.users.set("u-mgr", { user: { id: "u-mgr", name: "G", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] }, consultantId: null });
    addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br", scopes: TEAMS_AND_MAIL });
    const { minutes, state: mstate } = createMemoryMinutesStore();
    mstate.connectionsByUser.set("u-mgr", "c-mgr");
    mstate.consultantEmails.set("cons-ana", ["ana@jump.com.br"]);
    const mcp = (o: Partial<MinutesCheckpoint> = {}): MinutesCheckpoint => ({
      checkpointId: "chk1",
      managerUserId: "u-mgr",
      consultantId: "cons-ana",
      type: "ONE_ON_ONE",
      checkpointStatus: "DRAFT",
      notes: null,
      transcription: null,
      audioStorageKey: null,
      occurredAt: at(-HOUR),
      eventSubject: "1:1 Ana",
      eventStartAt: at(-HOUR),
      eventEndAt: END,
      eventCancelled: false,
      minutesStatus: null,
      eventJoinUrl: JOIN,
      eventOrganizerEmail: "gestor@jump.com.br",
      teamsStatus: null,
      ...o,
    });
    const graph = createFakeGraphClient();
    let now = at(30 * MIN);
    const deps: MinutesDeps = {
      store,
      minutes,
      graphFor: () => graph,
      ai: { complete: vi.fn(async () => null), completeWithDocument: vi.fn(async () => null) },
      runExtraction: vi.fn(async () => "done"),
      owner: "job-mail",
      now: () => now,
    };
    mstate.checkpoints.set("chk1", mcp());
    expect(await runMinutesRound(deps)).toMatchObject({ deferred: 1 });
    expect(graph.calls.mail).toEqual([]);

    now = at(3 * HOUR);
    mstate.checkpoints.set("chk1", mcp({ teamsStatus: "GENERATING", teamsLeaseUntil: at(3 * HOUR + MIN) }));
    expect(await runMinutesRound(deps)).toMatchObject({ deferred: 1 });
    // GENERATING órfão (lease nulo) não bloqueia o e-mail.
    mstate.checkpoints.set("chk1", mcp({ teamsStatus: "GENERATING", teamsLeaseUntil: null }));
    expect(await runMinutesRound(deps)).toMatchObject({ deferred: 0 });

    // Sem transcrição (final) ou passada 1 h sem status: o e-mail segue.
    mstate.checkpoints.set("chk1", mcp({ teamsStatus: "NO_TRANSCRIPT" }));
    expect(await runMinutesRound(deps)).toMatchObject({ deferred: 0 });
    expect(graph.calls.mail.length).toBeGreaterThan(0);
    mstate.checkpoints.set("chk1", mcp({ teamsStatus: null }));
    expect(await runMinutesRound(deps)).toMatchObject({ deferred: 0 });
  });
});

describe("idempotência e concorrência (claims no banco)", () => {
  it("rodada repetida depois de DONE não chama o Graph nem grava de novo", async () => {
    const s = setup();
    await runTranscriptRound(s.deps);
    const calls = s.graphs["c-mgr"].calls.teams.length;
    s.setNow(at(2 * HOUR));
    expect(await runTranscriptRound(s.deps)).toMatchObject({ enrolled: 0, saved: 0 });
    expect(s.graphs["c-mgr"].calls.teams).toHaveLength(calls);
    expect(s.tstate.saves).toHaveLength(1);
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "already_done" });
  });

  it("duas instâncias em paralelo: uma só lê e grava (lease da conexão + claim do registro)", async () => {
    const s = setup();
    const depsB: TranscriptDeps = { ...s.deps, owner: "job-B" };
    const [a, b] = await Promise.all([runTranscriptRound(s.deps), runTranscriptRound(depsB)]);
    expect(a.saved + b.saved).toBe(1);
    expect(s.tstate.saves).toHaveLength(1);
    expect(s.graphs["c-mgr"].calls.teams.filter((c) => c.op === "content")).toHaveLength(1);
  });

  it("registro com claim vivo de outra instância → record_busy; GENERATING abandonado (lease vencido) é retomado", async () => {
    const s = setup();
    await s.transcripts.enrollDueCheckpoints(at(15 * MIN), 10);
    expect(await s.transcripts.claim("chk1", "outra", at(20 * MIN), at(15 * MIN), false)).toBe(true);
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "record_busy" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    // A outra instância caiu no meio da geração.
    await s.transcripts.markGenerating("chk1", "outra", at(20 * MIN));
    s.setNow(at(21 * MIN));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("manual antes de 10 min → too_early; depois de 48 h → not_eligible", async () => {
    const s = setup({ now: at(5 * MIN) });
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "too_early" });
    s.setNow(at(49 * HOUR));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_eligible" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });

  it("manual reabre NO_TRANSCRIPT dentro de 48 h (o gestor sabe que a transcrição saiu)", async () => {
    const s = setup({ withTranscript: false });
    await runTranscriptRound(s.deps);
    const rec = record(s)!;
    rec.status = "NO_TRANSCRIPT";
    rec.nextAttemptAt = null;
    s.graphs["c-mgr"].addTranscript("meet-1", { id: "tr-1", content: VTT });
    s.setNow(at(8 * HOUR));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
  });
});

describe("correções 2 — nenhum estado sem saída", () => {
  it("lease da conexão perdido logo após markGenerating: não fica GENERATING órfão; a rodada seguinte retoma e gera", async () => {
    const s = setup();
    // 1º heartbeat (início do checkpoint) ok; 2º (logo antes/depois de GENERATING) falha.
    const orig = s.store.renewSyncLease.bind(s.store);
    let n = 0;
    s.store.renewSyncLease = async (...a: Parameters<typeof orig>) => {
      n += 1;
      return n === 2 ? false : orig(...a);
    };
    await runTranscriptRound(s.deps);
    expect(record(s)!.status).not.toBe("GENERATING");
    expect(record(s)!.leaseOwner).toBeNull();
    expect(checkpoint(s).notes).toBeNull();
    s.setNow(at(60 * MIN));
    await runTranscriptRound({ ...s.deps, owner: "job-B" });
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("falha DEPOIS de GENERATING (erro da conexão na IA/gravação) → volta a WAITING com backoff, lease solto", async () => {
    const s = setup();
    s.ai.complete.mockImplementationOnce(async () => {
      throw new GraphError("reauth", "401", { status: 401 });
    });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "WAITING_TRANSCRIPT", lastError: "interrupted", leaseOwner: null });
    expect(record(s)!.nextAttemptAt!.getTime()).toBeGreaterThan(at(15 * MIN).getTime());
  });

  it("GENERATING com lease NULO (dado legado/crash) é retomado pelo job, não trava o e-mail e libera o botão", async () => {
    const s = setup();
    await s.transcripts.ensureRecord("chk1", at(10 * MIN));
    Object.assign(s.tstate.records.get("chk1")!, { status: "GENERATING", leaseOwner: null, leaseUntil: null });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("registros não finais fora de 48 h (ex.: Teams desativado depois) → NO_TRANSCRIPT expired", async () => {
    const s = setup({ withTranscript: false });
    await runTranscriptRound(s.deps);
    expect(record(s)!.status).toBe("WAITING_TRANSCRIPT");
    s.tstate.teamsUsers.delete("u-mgr");
    s.setNow(at(49 * HOUR));
    expect(await runTranscriptRound(s.deps)).toMatchObject({ expired: 1 });
    expect(record(s)).toMatchObject({ status: "NO_TRANSCRIPT", lastError: "expired" });
  });
});

describe("correções M3", () => {
  it("403 depois de 24 h do fim (FAILED): nem botão nem job consultam por 24 h a partir do 403", async () => {
    const s = setup({ now: at(30 * HOUR) });
    s.graphs["c-mgr"].failNext(new GraphError("forbidden", "Graph respondeu 403.", { status: 403 }));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
    expect(record(s)).toMatchObject({ status: "FAILED", accessDeniedAt: at(30 * HOUR) });
    const calls = s.graphs["c-mgr"].calls.teams.length;
    for (const t of [31 * HOUR, 40 * HOUR, 47 * HOUR]) {
      s.setNow(at(t));
      expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
      await runTranscriptRound(s.deps);
    }
    expect(s.graphs["c-mgr"].calls.teams).toHaveLength(calls);
  });

  it("complemento não duplica a ação que a ata por e-mail já criou; ação nova entra", async () => {
    const s = setup({
      aiResponse: JSON.stringify({
        summary: "Resumo.",
        decisions: [],
        attentionPoints: [],
        actions: [
          { title: "Enviar plano de estudos", owner: "Ana", dueDate: "2026-12-05", quote: null },
          { title: "Marcar retorno", owner: null, dueDate: null, quote: null },
        ],
      }),
    });
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "RECORDED", notes: "Ata do e-mail", transcription: "fonte" }));
    s.tstate.actionItems.push({ checkpointId: "chk1", title: "enviar plano de estudos", ownerText: "Ana", dueDate: null, dueText: null, sourceQuote: null, status: "PENDING" });
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(s.tstate.actionItems.map((a) => a.title)).toEqual(["enviar plano de estudos", "Marcar retorno"]);
  });

  it("VTT cujo conteúdo é só um bloco gigante sem espaço: nunca vira ata 'com sucesso' (fica WAITING)", async () => {
    const s = setup();
    const vtt = `WEBVTT\n\n00:00.000 --> 00:01.000\n<v A>${"x".repeat(400_000)}\n`;
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-mgr", transcripts: [{ id: "tr-1", content: vtt }] });
    await runTranscriptRound(s.deps);
    expect(s.ai.complete).not.toHaveBeenCalled();
    expect(record(s)).toMatchObject({ status: "WAITING_TRANSCRIPT", lastError: "empty_transcript" });
    expect(checkpoint(s).notes).toBeNull();
  });

  it("monólogo acima do teto: início e fim da fala vão à IA (70/30 dentro dela)", async () => {
    const s = setup();
    const words = Array.from({ length: 80_000 }, (_, i) => `p${i}`).join(" ");
    const vtt = `WEBVTT\n\n${Array.from({ length: 200 }, (_, i) => `00:00.000 --> 00:01.000\n<v Ana>${words.slice(i * 2000, i * 2000 + 2000)}\n`).join("\n")}`;
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-mgr", transcripts: [{ id: "tr-1", content: vtt }] });
    await runTranscriptRound(s.deps);
    const prompt = (s.ai.complete.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("Ana: p0 p1 p2");
    expect(prompt).toContain("[… trecho");
  });
});

describe("VTT hostil no pipeline completo", () => {
  it("linha gigante cortada no teto nunca deixa fragmento de CPF/e-mail cru para a IA", async () => {
    const s = setup();
    // O CPF/e-mail cruzam o teto de linha (4000): o corte recua até antes deles.
    const filler = "palavra ".repeat(499); // 3992 caracteres
    const vtt = `WEBVTT\n\n00:00.000 --> 00:01.000\n<v A>${filler}123.456.789-09 joao.pereira@cliente.com.br fim\n`;
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-mgr", transcripts: [{ id: "tr-1", content: vtt }] });
    await runTranscriptRound(s.deps);
    const prompt = (s.ai.complete.mock.calls[0] as unknown as [string])[0];
    expect(prompt).not.toMatch(/\d{3}\.\d/);
    expect(prompt).not.toContain("joao");
  });

  it("VTT de 4 MB com tags/entidades abertas processa em < 2 s e não vaza nada cru", async () => {
    const s = setup();
    const line = `<v Ana ${"<".repeat(150)}>${"&# <x ".repeat(600)}`;
    const hostile = `WEBVTT\n\n00:00.000 --> 00:01.000\n${`${line}\n`.repeat(1000)}<v ${"<".repeat(10_000)}>${"&#".repeat(100_000)}\nfale com x@y.com.br\n\n00:00.000 --> 00:01.000\n<v Ana>conteúdo legítimo suficiente para a ata desta reunião\n`;
    expect(hostile.length).toBeGreaterThan(3_500_000);
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-mgr", transcripts: [{ id: "tr-1", content: hostile }] });
    const t0 = performance.now();
    await runTranscriptRound(s.deps);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s.ai.complete).toHaveBeenCalledTimes(1);
    const prompt = (s.ai.complete.mock.calls[0] as unknown as [string])[0];
    expect(prompt).not.toContain("x@y.com.br");
    expect(prompt).not.toContain("<v");
    // As linhas com anotação de voz malformada (`<` dentro de `<v …>`) foram descartadas.
    expect(prompt).toContain("Ana: conteúdo legítimo");
  });
});
