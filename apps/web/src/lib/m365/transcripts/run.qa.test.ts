import { describe, expect, it, vi } from "vitest";
import type { AiTextProvider } from "@/lib/ai/provider";
import { normalizeGraphEvent } from "../calendar/normalize";
import { createFakeGraphClient, type FakeGraph } from "../graph/fake";
import { GraphError } from "../graph/errors";
import { onlineMeetingFilterUrl } from "../graph/client";
import type { M365ConnectionRecord } from "../store";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { createMemoryTranscriptStore } from "../testing/memory-transcript-store";
import { fetchTranscriptNow, runTranscriptRound, type TranscriptDeps } from "./run";
import { TEAMS_EMAIL_HOLD_MS, emailShouldWaitForTeams, planAfterMiss } from "./schedule";
import type { TranscriptCheckpoint } from "./store";

/**
 * M3 — QA da transcrição do Teams (testador). Graph fake, IA mockada, store em
 * memória; nada real. Achados ficam como `it.fails` (passam enquanto o bug
 * existir; quando corrigido, trocar por `it`).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const END = new Date("2026-11-26T14:00:00.000Z");
const at = (ms: number) => new Date(END.getTime() + ms);
/** Link real típico do Teams (como o Graph devolve em `onlineMeeting.joinUrl`). */
const JOIN =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA2ZDk0YTMtZTRlYS00YjU1LWE5ZDEtYzhjNGU3MmNkZjEz%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2c%22Oid%22%3a%22550fae72-d251-43ec-868c-373732c2704f%22%7d";
const BASE = ["openid", "profile", "offline_access", "User.Read", "Calendars.Read"];
const TEAMS = [...BASE, "OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"];

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

function setup(opts: { now?: Date; aiResponse?: string | null; withTranscript?: boolean } = {}) {
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
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br", graphUserId: "g-mgr", scopes: TEAMS });
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br", graphUserId: "g-ana", scopes: TEAMS });

  const { transcripts, state: tstate } = createMemoryTranscriptStore();
  tstate.connectionsByUser.set("u-mgr", "c-mgr");
  tstate.connectionsByUser.set("u-ana", "c-ana");
  tstate.teamsUsers.add("u-mgr");
  tstate.teamsUsers.add("u-ana");
  tstate.checkpoints.set("chk1", cp());

  const graphs: Record<string, FakeGraph> = { "c-mgr": createFakeGraphClient(), "c-ana": createFakeGraphClient() };
  graphs["c-mgr"].addOnlineMeeting({
    id: "meet-1",
    joinWebUrl: JOIN,
    organizerId: "g-mgr",
    transcripts: opts.withTranscript === false ? [] : [{ id: "tr-1", createdDateTime: "2026-11-26T14:01:00Z", content: VTT }],
  });
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

type S = ReturnType<typeof setup>;
const record = (s: S) => s.tstate.records.get("chk1");
const checkpoint = (s: S) => s.tstate.checkpoints.get("chk1")!;

describe("joinUrl: o valor guardado pela M1 é o que vai ao filtro do Graph", () => {
  const rawEvent = (joinUrl: string) => ({
    id: "ev1",
    iCalUId: "ical-1",
    subject: "1:1 Ana",
    start: { dateTime: "2026-11-26T13:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-11-26T14:00:00.0000000", timeZone: "UTC" },
    organizer: { emailAddress: { address: "gestor@jump.com.br" } },
    attendees: [],
    isOnlineMeeting: true,
    onlineMeeting: { joinUrl },
  });
  const filterOf = (url: string) => decodeURIComponent(url.slice(url.indexOf("$filter=") + 8, url.indexOf("&$select")));

  it.each([
    ["meetup-join clássico (%3a, %40, context=%7b…%7d)", JOIN],
    ["formato novo /meet/<id>?p=", "https://teams.microsoft.com/meet/21234567890123?p=AbCdEfGhIjKlMnOp"],
    ["com &anon=true e fragmento", "https://teams.microsoft.com/l/meetup-join/19%3ameeting_a%40thread.v2/0?context=%7b%7d&anon=true#x"],
  ])("%s: M1 guarda byte a byte e o $filter decodificado é o link ORIGINAL do Graph", (_label, original) => {
    const n = normalizeGraphEvent(rawEvent(original));
    expect(n.kind).toBe("event");
    const stored = n.kind === "event" ? n.event.joinUrl : null;
    expect(stored).toBe(original);
    const url = onlineMeetingFilterUrl(stored!)!;
    expect(filterOf(url)).toBe(`JoinWebUrl eq '${original}'`);
    // & e # do link não vazam como parâmetros da URL do Graph.
    expect(url.split("&")).toHaveLength(2);
    expect(url).not.toContain("#");
  });

  it("pipeline: o job consulta o Graph com exatamente o joinUrl gravado (nada re-normalizado)", async () => {
    const s = setup();
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams[0]).toEqual({ op: "meeting", joinUrl: JOIN });
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  // ACHADO (menor): `sanitizeJoinUrl` (calendar/normalize.ts:84) grava `new URL().toString()`.
  // Para links que o Graph devolva com host em maiúsculas, porta :443 explícita
  // ou JSON do `context` sem percent-encoding, o valor gravado difere do
  // `joinWebUrl` do Graph e o filtro exato `JoinWebUrl eq` não casa
  // (→ meeting_not_found → NO_TRANSCRIPT; nunca dado errado).
  it.each([
    ["context sem encoding", 'https://teams.microsoft.com/l/meetup-join/19:meeting_abc@thread.v2/0?context={"Tid":"t","Oid":"o"}'],
    ["host em maiúsculas", "https://Teams.Microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0"],
    ["porta :443 explícita", "https://teams.microsoft.com:443/l/meetup-join/19%3ameeting_abc%40thread.v2/0"],
  ])("variação %s: M1 deveria guardar o link como veio do Graph", (_label, original) => {
    const n = normalizeGraphEvent(rawEvent(original));
    expect(n.kind === "event" ? n.event.joinUrl : null).toBe(original);
  });
});

describe("só a conta do GESTOR organizador (complementos)", () => {
  it("store devolve a conexão do CONSULTOR para o gestor → recusada, zero chamadas a qualquer conta", async () => {
    const s = setup();
    s.tstate.connectionsByUser.set("u-mgr", "c-ana");
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-ana"].calls.teams).toEqual([]);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_connected" });
    expect(s.graphs["c-ana"].calls.teams).toEqual([]);
    expect(checkpoint(s).notes).toBeNull();
  });

  it("consultor com Teams e checkpoint próprio em rascunho: nunca é usado, nem pelo job nem pelo botão", async () => {
    const s = setup();
    // O consultor tenta acionar a busca do checkpoint dele.
    expect(await fetchTranscriptNow("chk1", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-ana"].calls.teams).toEqual([]);
    expect(s.state.connections.get("c-ana")!.leaseOwner).toBeNull();
  });

  it("gestor perdeu o papel de quem registra checkpoint → nada lido", async () => {
    const s = setup();
    s.state.users.set("u-mgr", {
      user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: ["CONSULTANT"] },
      consultantId: null,
    });
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });

  it("gestor com só UM dos escopos do Teams → nada lido (Teams exige os dois)", async () => {
    const s = setup();
    s.state.connections.get("c-mgr")!.scopes = [...BASE, "OnlineMeetings.Read"];
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_connected" });
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });

  it("not_organizer pelo Graph: só a busca da reunião, nada de transcripts/content nem IA, sem aviso", async () => {
    const s = setup();
    s.graphs["c-mgr"].addOnlineMeeting({ id: "meet-1", joinWebUrl: JOIN, organizerId: "g-ana", transcripts: [{ id: "tr-1", content: VTT }] });
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_eligible" });
    expect(s.graphs["c-mgr"].calls.teams.map((c) => c.op)).toEqual(["meeting"]);
    expect(s.ai.complete).not.toHaveBeenCalled();
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "not_organizer" });
    expect(s.tstate.notifications).toEqual([]);
  });
});

describe("máquina de estados / backoff / 403", () => {
  it("planAfterMiss: backoff 15/30/60/120 e 120 repetido; nunca passa de 6 h; 6 h exatas → NO_TRANSCRIPT", () => {
    let now = at(10 * MIN);
    const seen: number[] = [];
    for (let misses = 1; misses < 20; misses += 1) {
      const plan = planAfterMiss({ kind: "no_transcript" }, { endAt: END, now, misses });
      if (plan.status !== "WAITING_TRANSCRIPT") {
        expect(plan).toMatchObject({ status: "NO_TRANSCRIPT", notify: true });
        break;
      }
      seen.push((plan.nextAttemptAt!.getTime() - now.getTime()) / MIN);
      expect(plan.nextAttemptAt!.getTime()).toBeLessThanOrEqual(at(6 * HOUR).getTime());
      now = plan.nextAttemptAt!;
    }
    expect(seen).toEqual([15, 30, 60, 120, 120, 5]);
    expect(now).toEqual(at(6 * HOUR));
  });

  it("403 → WAITING 24 h; 403 depois de 24 h do fim → FAILED (a próxima passaria de 48 h)", () => {
    expect(planAfterMiss({ kind: "forbidden" }, { endAt: END, now: at(23 * HOUR), misses: 1 })).toMatchObject({
      status: "WAITING_TRANSCRIPT",
      nextAttemptAt: at(47 * HOUR),
      error: "access_denied",
    });
    expect(planAfterMiss({ kind: "forbidden" }, { endAt: END, now: at(25 * HOUR), misses: 1 })).toMatchObject({
      status: "FAILED",
      nextAttemptAt: null,
      error: "access_denied",
      notify: true,
    });
  });

  it("transitório (5xx) segue backoff para além de 6 h e vira FAILED só depois de 48 h", () => {
    const p = planAfterMiss({ kind: "transient", code: "http_503" }, { endAt: END, now: at(7 * HOUR), misses: 5 });
    expect(p).toMatchObject({ status: "WAITING_TRANSCRIPT", nextAttemptAt: at(9 * HOUR) });
    expect(planAfterMiss({ kind: "transient", code: "http_503" }, { endAt: END, now: at(47 * HOUR), misses: 9 })).toMatchObject({
      status: "FAILED",
      notify: true,
    });
  });

  it("job: 429/throttling na reunião não marca nada nem consome tentativa (rodada interrompida)", async () => {
    const s = setup();
    s.graphs["c-mgr"].failNext(new GraphError("throttled", "429", { status: 429, retryAfterSeconds: 30 } as never));
    await runTranscriptRound(s.deps);
    expect(s.state.connections.get("c-mgr")!.status).toBe("ACTIVE");
    expect(record(s)).toMatchObject({ status: "PENDING", attempts: 0, leaseOwner: null });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("IA que LANÇA → volta a esperar com backoff (WAITING), nada gravado no checkpoint", async () => {
    const s = setup();
    s.ai.complete.mockImplementationOnce(async () => {
      throw new Error("boom com gestor.pessoal@gmail.com");
    });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "WAITING_TRANSCRIPT", leaseOwner: null });
    expect(record(s)!.lastError ?? "").not.toContain("gestor.pessoal");
    expect(checkpoint(s).notes).toBeNull();
    expect(s.tstate.actionItems).toEqual([]);
  });

  it("botão do gestor durante o bloqueio de 403 (WAITING) não consulta; depois de 24 h consulta", async () => {
    const s = setup();
    s.graphs["c-mgr"].failNext(new GraphError("forbidden", "Graph respondeu 403.", { status: 403 }));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
    s.setNow(at(23 * HOUR));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });

  // ACHADO (importante): 403 recebido depois de 24 h do fim grava FAILED com
  // `nextAttemptAt = null` (schedule.ts:124). O bloqueio do botão
  // (run.ts:463) só olha `nextAttemptAt > now`, então o gestor consegue
  // consultar o Graph de novo minutos depois do 403 (claim `force` reabre FAILED).
  it("403 após 24 h do fim (FAILED access_denied): botão NÃO consulta de novo antes de 24 h", async () => {
    const s = setup({ now: at(25 * HOUR) });
    s.graphs["c-mgr"].failNext(new GraphError("forbidden", "Graph respondeu 403.", { status: 403 }));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "access_denied" });
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "access_denied" });
    s.setNow(at(26 * HOUR));
    await fetchTranscriptNow("chk1", "u-mgr", s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
  });

  it("GENERATING com lease vivo de outra instância não é retomado; vencido é", async () => {
    const s = setup();
    await s.transcripts.enrollDueCheckpoints(at(15 * MIN), 10);
    await s.transcripts.claim("chk1", "outra", at(20 * MIN), at(15 * MIN), false);
    await s.transcripts.markGenerating("chk1", "outra", at(20 * MIN));
    s.setNow(at(19 * MIN));
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(record(s)).toMatchObject({ status: "GENERATING", leaseOwner: "outra" });
    // Gravação da instância antiga depois de perder o lease é recusada.
    s.setNow(at(21 * MIN));
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "DONE" });
    expect(await s.transcripts.recordAttempt("chk1", "outra", { status: "FAILED", nextAttemptAt: null, error: "x" }, at(22 * MIN))).toBe(false);
    expect(record(s)).toMatchObject({ status: "DONE" });
  });

  it("idempotência: botão repetido após DONE e rodadas seguintes não chamam o Graph nem duplicam cards", async () => {
    const s = setup();
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    const calls = s.graphs["c-mgr"].calls.teams.length;
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "already_done" });
    s.setNow(at(3 * HOUR));
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toHaveLength(calls);
    expect(s.tstate.actionItems).toHaveLength(1);
  });
});

describe("conteúdo: teto, ordem e VTT nunca persistido", () => {
  it("teto TOTAL por reunião: duas transcrições que somadas passam do teto → FAILED too_large, nada à IA", async () => {
    const s = setup();
    const big = `${VTT}\n\n4\n00:00:20.000 --> 00:00:30.000\n<v Ana Souza>${"conteúdo ".repeat(40)}</v>`;
    s.deps.maxVttBytes = Buffer.byteLength(big, "utf8") + 100;
    s.graphs["c-mgr"].addOnlineMeeting({
      id: "meet-1",
      joinWebUrl: JOIN,
      organizerId: "g-mgr",
      transcripts: [
        { id: "tr-1", createdDateTime: "2026-11-26T14:01:00Z", content: big },
        { id: "tr-2", createdDateTime: "2026-11-26T14:02:00Z", content: big },
      ],
    });
    await runTranscriptRound(s.deps);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "transcript_too_large" });
    expect(s.ai.complete).not.toHaveBeenCalled();
    expect(checkpoint(s).transcription).toBeNull();
  });

  it("várias transcrições: ordem de criação (não a da lista), no máximo 5", async () => {
    const s = setup();
    const mk = (n: number) => `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Fala${n}>Trecho número ${n} da reunião de hoje.</v>`;
    s.graphs["c-mgr"].addOnlineMeeting({
      id: "meet-1",
      joinWebUrl: JOIN,
      organizerId: "g-mgr",
      transcripts: [6, 3, 1, 5, 2, 4].map((n) => ({ id: `tr-${n}`, createdDateTime: `2026-11-26T14:0${n}:00Z`, content: mk(n) })),
    });
    await runTranscriptRound(s.deps);
    const contents = s.graphs["c-mgr"].calls.teams.filter((c) => c.op === "content").map((c) => c.id);
    expect(contents).toEqual(["tr-1", "tr-2", "tr-3", "tr-4", "tr-5"]);
    const t = checkpoint(s).transcription!;
    expect(t.indexOf("número 1")).toBeLessThan(t.indexOf("número 5"));
    expect(t).not.toContain("número 6");
  });

  it("nada do VTT bruto (cabeçalho, horários, tags, dados crus) em nenhum lugar persistido/logado", async () => {
    const s = setup();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spyLog = vi.spyOn(console, "log").mockImplementation(() => {});
    await runTranscriptRound(s.deps);
    const persisted = JSON.stringify({
      records: [...s.tstate.records.values()],
      saves: s.tstate.saves.map((x) => ({ ...x, notes: "", actionItems: [] })),
      logs: s.state.logs,
      notifications: s.tstate.notifications,
      console: [spy.mock.calls, spyLog.mock.calls],
    });
    for (const raw of ["WEBVTT", "-->", "00:00:01", "<v ", "</v>", "123.456.789-09", "98765-4321", "gestor.pessoal@gmail.com"]) {
      expect(persisted).not.toContain(raw);
    }
    // A ata (notas) é a ÚNICA coisa desmascarada; a fonte guardada é mascarada.
    expect(checkpoint(s).notes).toContain("gestor.pessoal@gmail.com");
    expect(checkpoint(s).transcription).toContain("[EMAIL_1]");
    spy.mockRestore();
    spyLog.mockRestore();
  });

  it("mascarar antes da IA também no complemento: notas existentes com PII vão mascaradas à extração", async () => {
    const s = setup();
    s.tstate.checkpoints.set(
      "chk1",
      cp({ checkpointStatus: "RECORDED", notes: "Ata do e-mail: ligar para outra.pessoa@cliente.com.br", transcription: "fonte [EMAIL_1]" }),
    );
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    const [prompt, opts] = s.ai.complete.mock.calls[0] as unknown as [string, { system: string }];
    expect(prompt + opts.system).not.toContain("outra.pessoa@cliente.com.br");
    expect(prompt).not.toContain("123.456.789-09");
    const [, input] = s.runExtraction.mock.calls[0] as unknown as [string, { maskedNotes: string; maskedTranscription: string }];
    expect(input.maskedNotes).not.toContain("outra.pessoa@cliente.com.br");
    expect(input.maskedTranscription).not.toContain("123.456.789-09");
  });
});

describe("precedência com o e-mail", () => {
  const base = { teamsEnabled: true, organizedByManager: true, eventJoinUrl: JOIN, eventEndAt: END };

  it("espera do job de e-mail: até 1 h exata após o fim; nunca para reunião sem Teams/sem gestor organizador", () => {
    expect(TEAMS_EMAIL_HOLD_MS).toBe(HOUR);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: null, now: at(HOUR - 1) })).toBe(true);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "WAITING_TRANSCRIPT", now: at(HOUR - 1) })).toBe(true);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: null, now: at(HOUR) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "WAITING_TRANSCRIPT", now: at(2 * HOUR) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsEnabled: false, teamsStatus: null, now: at(MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, organizedByManager: false, teamsStatus: null, now: at(MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, eventJoinUrl: null, teamsStatus: null, now: at(MIN) })).toBe(false);
    // GENERATING só segura com lease VIVO (correções 2 da M3: órfão não trava o e-mail).
    expect(
      emailShouldWaitForTeams({ ...base, teamsEnabled: false, teamsStatus: "GENERATING", teamsLeaseUntil: at(40 * HOUR + MIN), now: at(40 * HOUR) }),
    ).toBe(true);
    expect(emailShouldWaitForTeams({ ...base, teamsEnabled: false, teamsStatus: "GENERATING", teamsLeaseUntil: null, now: at(40 * HOUR) })).toBe(false);
    // DONE = a transcrição já venceu.
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "DONE", now: at(40 * HOUR) })).toBe(true);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "FAILED", now: at(MIN) })).toBe(false);
  });

  it("job nunca complementa sozinho: checkpoint com notas do gestor (DRAFT) → superseded sem ler o Teams", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ notes: "anotações do gestor" }));
    await s.transcripts.ensureRecord("chk1", at(10 * MIN));
    await runTranscriptRound(s.deps);
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(record(s)).toMatchObject({ status: "FAILED", lastError: "superseded" });
    expect(checkpoint(s).notes).toBe("anotações do gestor");
  });

  it("complemento manual: notas existentes preservadas no início, sem rebaixar status; EXTRACTED segue EXTRACTED", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "EXTRACTED", notes: "Ata do e-mail", transcription: "Fonte e-mail" }));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(checkpoint(s).checkpointStatus).toBe("EXTRACTED");
    expect(checkpoint(s).notes!.startsWith("Ata do e-mail")).toBe(true);
    expect(checkpoint(s).transcription!.startsWith("Fonte e-mail")).toBe(true);
  });

  it("complemento em checkpoint ARQUIVADO → recusado, nada gravado", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "ARCHIVED", notes: "Ata" }));
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_eligible" });
    expect(s.graphs["c-mgr"].calls.teams).toEqual([]);
    expect(checkpoint(s).notes).toBe("Ata");
  });

  // ACHADO (importante): o complemento grava os cards de Ação da transcrição sem
  // olhar os cards já criados pela ata por e-mail (M2) — `saveTranscriptMinutes`
  // (lib/db/m365-transcripts.ts:281) faz `createMany` incondicional e
  // `TranscriptCheckpoint` nem carrega os cards existentes. A mesma ação dita na
  // reunião e escrita na ata vira dois cards PENDING.
  it("complementar não duplica card de Ação que a ata por e-mail já criou", async () => {
    const s = setup();
    s.tstate.checkpoints.set("chk1", cp({ checkpointStatus: "RECORDED", notes: "Ata do e-mail", transcription: "Fonte e-mail" }));
    // Card criado pela M2 (mesma tabela CheckpointActionItem).
    s.tstate.actionItems.push({
      checkpointId: "chk1",
      title: "Enviar plano de estudos",
      ownerText: "Ana",
      dueDate: null,
      dueText: "2026-12-05",
      sourceQuote: null,
      status: "PENDING",
    } as (typeof s.tstate.actionItems)[number]);
    expect(await fetchTranscriptNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    const same = s.tstate.actionItems.filter((a) => a.title.toLowerCase() === "enviar plano de estudos");
    expect(same).toHaveLength(1);
  });
});
