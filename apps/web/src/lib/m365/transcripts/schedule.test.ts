import { describe, expect, it } from "vitest";
import {
  TEAMS_EMAIL_HOLD_MS,
  backoffDelay,
  canTransition,
  emailShouldWaitForTeams,
  firstAttemptAt,
  isFinalStatus,
  planAfterMiss,
  transcriptEligibility,
  transcriptMode,
  type TranscriptEligibilityInput,
  type TranscriptStatus,
} from "./schedule";

const MIN = 60_000;
const HOUR = 60 * MIN;
const END = new Date("2026-11-26T14:00:00.000Z");
const at = (ms: number) => new Date(END.getTime() + ms);

describe("máquina de estados", () => {
  it("transições permitidas e estados finais", () => {
    const all: TranscriptStatus[] = ["PENDING", "WAITING_TRANSCRIPT", "GENERATING", "DONE", "NO_TRANSCRIPT", "FAILED"];
    expect(canTransition("PENDING", "WAITING_TRANSCRIPT")).toBe(true);
    expect(canTransition("WAITING_TRANSCRIPT", "GENERATING")).toBe(true);
    expect(canTransition("GENERATING", "DONE")).toBe(true);
    expect(canTransition("GENERATING", "FAILED")).toBe(true);
    expect(canTransition("WAITING_TRANSCRIPT", "NO_TRANSCRIPT")).toBe(true);
    expect(canTransition("PENDING", "DONE")).toBe(false);
    expect(canTransition("WAITING_TRANSCRIPT", "DONE")).toBe(false);
    for (const final of ["DONE", "NO_TRANSCRIPT", "FAILED"] as const) {
      expect(isFinalStatus(final)).toBe(true);
      for (const to of all) expect(canTransition(final, to)).toBe(false);
    }
  });
});

describe("agenda de tentativas", () => {
  it("1ª consulta 10 min após o fim; backoff 15 → 30 → 60 → 120 (repete 120)", () => {
    expect(firstAttemptAt(END)).toEqual(at(10 * MIN));
    expect([1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([15, 30, 60, 120, 120, 120].map((m) => m * MIN));
  });

  it("sequência completa sem transcrição: 10m, 25m, 55m, 1h55, 3h55, 5h55, 6h → NO_TRANSCRIPT com aviso", () => {
    let now = firstAttemptAt(END);
    const seen: number[] = [];
    let misses = 0;
    for (;;) {
      misses += 1;
      seen.push(Math.round((now.getTime() - END.getTime()) / MIN));
      const plan = planAfterMiss({ kind: "no_transcript" }, { endAt: END, now, misses });
      if (plan.status !== "WAITING_TRANSCRIPT") {
        expect(plan).toEqual({ status: "NO_TRANSCRIPT", nextAttemptAt: null, error: null, notify: true });
        break;
      }
      expect(plan.notify).toBe(false);
      now = plan.nextAttemptAt!;
    }
    expect(seen).toEqual([10, 25, 55, 115, 235, 355, 360]);
  });

  it("reunião não encontrada / transcrição vazia seguem o mesmo backoff com código curto", () => {
    expect(planAfterMiss({ kind: "no_meeting" }, { endAt: END, now: at(10 * MIN), misses: 1 })).toMatchObject({
      status: "WAITING_TRANSCRIPT",
      error: "meeting_not_found",
      nextAttemptAt: at(25 * MIN),
    });
    expect(planAfterMiss({ kind: "empty_transcript" }, { endAt: END, now: at(7 * HOUR), misses: 3 })).toMatchObject({
      status: "NO_TRANSCRIPT",
      error: "empty_transcript",
      notify: true,
    });
  });

  it("403: sem nova tentativa por 24 h; a seguinte passaria de 48 h → FAILED access_denied com aviso", () => {
    const first = planAfterMiss({ kind: "forbidden" }, { endAt: END, now: at(10 * MIN), misses: 1 });
    expect(first).toEqual({
      status: "WAITING_TRANSCRIPT",
      nextAttemptAt: at(10 * MIN + 24 * HOUR),
      error: "access_denied",
      notify: false,
      accessDeniedAt: at(10 * MIN),
    });
    const second = planAfterMiss({ kind: "forbidden" }, { endAt: END, now: first.nextAttemptAt!, misses: 2 });
    expect(second).toEqual({
      status: "FAILED",
      nextAttemptAt: null,
      error: "access_denied",
      notify: true,
      accessDeniedAt: first.nextAttemptAt,
    });
  });

  it("erro transitório: backoff até 48 h; grande demais e não organizador = FAILED", () => {
    expect(planAfterMiss({ kind: "transient", code: "http:500" }, { endAt: END, now: at(7 * HOUR), misses: 6 })).toMatchObject({
      status: "WAITING_TRANSCRIPT",
      nextAttemptAt: at(9 * HOUR),
    });
    expect(planAfterMiss({ kind: "transient", code: "http:500" }, { endAt: END, now: at(47 * HOUR), misses: 9 })).toMatchObject({
      status: "FAILED",
      notify: true,
    });
    expect(planAfterMiss({ kind: "too_large" }, { endAt: END, now: at(HOUR), misses: 1 })).toMatchObject({
      status: "FAILED",
      error: "transcript_too_large",
      notify: true,
    });
    expect(planAfterMiss({ kind: "not_organizer" }, { endAt: END, now: at(HOUR), misses: 1 })).toMatchObject({
      status: "FAILED",
      error: "not_organizer",
      notify: false,
    });
  });
});

describe("elegibilidade, modo e precedência", () => {
  const cp = (o: Partial<TranscriptEligibilityInput> = {}): TranscriptEligibilityInput => ({
    checkpointStatus: "DRAFT",
    notes: null,
    transcription: null,
    audioStorageKey: null,
    eventJoinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
    eventOrganizerEmail: "Gestor@Jump.com.br",
    eventEndAt: END,
    eventCancelled: false,
    ...o,
  });
  const mgr = ["gestor@jump.com.br"];

  it("janela 10 min – 48 h, só Teams, não cancelado, organizado pelo gestor", () => {
    expect(transcriptEligibility(cp(), mgr, at(10 * MIN))).toBe("ok");
    expect(transcriptEligibility(cp(), mgr, at(9 * MIN))).toBe("too_early");
    expect(transcriptEligibility(cp(), mgr, at(48 * HOUR + 1))).toBe("too_late");
    expect(transcriptEligibility(cp({ eventJoinUrl: null }), mgr, at(HOUR))).toBe("not_teams");
    expect(transcriptEligibility(cp({ eventCancelled: true }), mgr, at(HOUR))).toBe("cancelled");
    expect(transcriptEligibility(cp({ eventOrganizerEmail: "ana@jump.com.br" }), mgr, at(HOUR))).toBe("not_organizer");
    expect(transcriptEligibility(cp({ eventOrganizerEmail: null }), mgr, at(HOUR))).toBe("not_organizer");
    expect(transcriptEligibility(cp({ checkpointStatus: "ARCHIVED" }), mgr, at(HOUR))).toBe("archived");
  });

  it("modo: rascunho vazio gera; com ata/notas/áudio só complementa", () => {
    expect(transcriptMode(cp())).toBe("GENERATE");
    expect(transcriptMode(cp({ notes: "   " }))).toBe("GENERATE");
    expect(transcriptMode(cp({ notes: "ata do e-mail", checkpointStatus: "RECORDED" }))).toBe("SUPPLEMENT");
    expect(transcriptMode(cp({ notes: "minhas notas" }))).toBe("SUPPLEMENT");
    expect(transcriptMode(cp({ audioStorageKey: "k" }))).toBe("SUPPLEMENT");
  });

  it("e-mail espera o Teams: DONE; GENERATING com lease vivo em 48 h; senão só reunião Teams do gestor com Teams ativo até 1 h", () => {
    const base = { teamsStatus: null, teamsEnabled: true, organizedByManager: true, eventJoinUrl: "https://teams.microsoft.com/x", eventEndAt: END };
    expect(emailShouldWaitForTeams({ ...base, now: at(30 * MIN) })).toBe(true);
    expect(emailShouldWaitForTeams({ ...base, now: at(TEAMS_EMAIL_HOLD_MS) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "GENERATING", teamsLeaseUntil: at(5 * HOUR + MIN), now: at(5 * HOUR) })).toBe(true);
    // GENERATING órfão (lease nulo/vencido) ou fora de 48 h não trava o e-mail.
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "GENERATING", teamsLeaseUntil: null, now: at(5 * HOUR) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "GENERATING", teamsLeaseUntil: at(4 * HOUR), now: at(5 * HOUR) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "GENERATING", teamsLeaseUntil: at(49 * HOUR), now: at(48 * HOUR + 1) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "NO_TRANSCRIPT", now: at(30 * MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsStatus: "FAILED", now: at(30 * MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, teamsEnabled: false, now: at(30 * MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, organizedByManager: false, now: at(30 * MIN) })).toBe(false);
    expect(emailShouldWaitForTeams({ ...base, eventJoinUrl: null, now: at(30 * MIN) })).toBe(false);
  });
});
