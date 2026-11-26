import { describe, expect, it, vi } from "vitest";
import type { AiTextProvider } from "@/lib/ai/provider";
import { createFakeGraphClient, type FakeGraph, type FakeMessage } from "../graph/fake";
import { GraphError } from "../graph/errors";
import type { M365ConnectionRecord } from "../store";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { createMemoryMinutesStore } from "../testing/memory-minutes-store";
import {
  chooseMinutesMessage,
  isMinutesEligible,
  listMinutesChoices,
  runMinutesRound,
  searchMinutesNow,
  type MinutesDeps,
} from "./run";
import type { MinutesCheckpoint } from "./store";

const NOW = new Date("2026-11-26T15:00:00.000Z");
const M2 = ["openid", "profile", "offline_access", "User.Read", "Calendars.Read", "Mail.Read"];

const AI_OK = JSON.stringify({
  summary: "Conversa sobre o projeto [EMAIL_1].",
  decisions: ["Manter a alocação atual"],
  attentionPoints: ["Sobrecarga em dezembro"],
  actions: [
    { title: "Enviar plano de estudos", owner: "Ana", dueDate: "2026-12-05", quote: "vou mandar o plano até dia 5" },
    { title: "Revisar metas", owner: null, dueDate: "próxima semana", quote: null },
  ],
});

function msg(id: string, o: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    internetMessageId: `<${id}@mail>`,
    subject: "Ata: 1:1 Ana",
    receivedDateTime: "2026-11-24T15:00:00Z",
    from: { emailAddress: { name: "Gestor", address: "gestor@jump.com.br" } },
    toRecipients: [{ emailAddress: { name: "Ana", address: "ana@jump.com.br" } }],
    ccRecipients: [],
    categories: [],
    webLink: "https://outlook.office365.com/owa/?ItemID=abc",
    body: {
      contentType: "text",
      content: "corpo completo",
      uniqueContentType: "text",
      uniqueContent:
        "Combinamos manter a alocação. Contato: ana.silva@cliente.com.br, tel (11) 98765-4321, CPF 123.456.789-09, CNPJ 12.345.678/0001-90.\n\nDe: Ana\nEnviado: ontem\nmensagem antiga",
    },
    ...o,
  };
}

function checkpoint(o: Partial<MinutesCheckpoint> = {}): MinutesCheckpoint {
  return {
    checkpointId: "chk1",
    managerUserId: "u-mgr",
    consultantId: "cons-ana",
    type: "ONE_ON_ONE",
    checkpointStatus: "DRAFT",
    notes: null,
    transcription: null,
    audioStorageKey: null,
    occurredAt: new Date("2026-11-24T13:00:00Z"),
    eventSubject: "1:1 Ana",
    eventStartAt: new Date("2026-11-24T13:00:00Z"),
    eventEndAt: new Date("2026-11-24T13:30:00Z"),
    eventCancelled: false,
    minutesStatus: null,
    ...o,
  };
}

function setup(opts: { aiResponse?: string | null; managerRoles?: string[] } = {}) {
  const { store, state } = createMemoryStore();
  state.users.set("u-mgr", {
    user: { id: "u-mgr", name: "Gestor", email: "gestor@jump.com.br", roles: (opts.managerRoles ?? ["PROJECT_MANAGER"]) as never },
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
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br", scopes: M2 });
  // O consultor também conectou E ativou e-mail: mesmo assim nunca é lido.
  addConnection(state, { id: "c-ana", userId: "u-ana", mailbox: "ana@jump.com.br", scopes: M2 });
  addConnection(state, { id: "c-admin", userId: "u-admin", mailbox: "admin@jump.com.br", scopes: M2 });

  const { minutes, state: mstate } = createMemoryMinutesStore();
  mstate.connectionsByUser.set("u-mgr", "c-mgr");
  mstate.connectionsByUser.set("u-ana", "c-ana");
  mstate.connectionsByUser.set("u-admin", "c-admin");
  mstate.consultantEmails.set("cons-ana", ["ana@jump.com.br"]);
  mstate.checkpoints.set("chk1", checkpoint());

  const graphs: Record<string, FakeGraph> = {
    "c-mgr": createFakeGraphClient(),
    "c-ana": createFakeGraphClient(),
    "c-admin": createFakeGraphClient(),
  };
  const ai = {
    complete: vi.fn(async () => (opts.aiResponse === undefined ? AI_OK : opts.aiResponse)),
    completeWithDocument: vi.fn(async () => null),
  } satisfies AiTextProvider;
  const runExtraction = vi.fn(async () => "done");
  const deps: MinutesDeps = {
    store,
    minutes,
    graphFor: (c: M365ConnectionRecord) => graphs[c.id],
    ai,
    runExtraction,
    owner: "test",
    now: () => NOW,
  };
  return { store, state, minutes, mstate, graphs, ai, runExtraction, deps };
}

describe("isMinutesEligible", () => {
  it("só DRAFT, evento encerrado há < 7 dias, não cancelado e sem conteúdo", () => {
    expect(isMinutesEligible(checkpoint(), NOW)).toBe(true);
    expect(isMinutesEligible(checkpoint({ eventEndAt: new Date("2026-11-26T16:00:00Z") }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ eventEndAt: new Date("2026-11-19T15:00:00Z") }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ eventCancelled: true }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ notes: "anotei" }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ notes: "   " }), NOW)).toBe(true);
    expect(isMinutesEligible(checkpoint({ audioStorageKey: "k" }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ checkpointStatus: "RECORDED" }), NOW)).toBe(false);
    expect(isMinutesEligible(checkpoint({ minutesStatus: "DONE" }), NOW)).toBe(false);
  });
});

describe("runMinutesRound — seleção e gravação", () => {
  it("uma candidata: grava ata, transcrição MASCARADA, RECORDED, origem, cards PENDING, extração e aviso", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary).toMatchObject({ saved: 1, ambiguous: 0 });

    const cp = s.mstate.checkpoints.get("chk1")!;
    expect(cp.checkpointStatus).toBe("RECORDED");
    expect(cp.notes).toContain("Resumo");
    expect(cp.notes).toContain("Decisões");
    expect(cp.notes).toContain("Pontos de atenção");
    expect(cp.notes).toContain("Enviar plano de estudos — responsável: Ana — prazo: 2026-12-05");
    // texto-fonte mascarado, sem o histórico citado
    expect(cp.transcription).toContain("[EMAIL_1]");
    expect(cp.transcription).toContain("[TELEFONE_1]");
    expect(cp.transcription).toContain("[CPF_1]");
    expect(cp.transcription).toContain("[CNPJ_1]");
    expect(cp.transcription).not.toMatch(/ana\.silva@|98765-4321|123\.456\.789-09|12\.345\.678\/0001-90/);
    expect(cp.transcription).not.toContain("mensagem antiga");

    const rec = s.mstate.minutes.get("chk1")!;
    expect(rec).toMatchObject({
      status: "DONE",
      internetMessageId: "<m1@mail>",
      webLink: "https://outlook.office365.com/owa/?ItemID=abc",
      aiSummary: true,
    });
    expect(rec.receivedAt?.toISOString()).toBe("2026-11-24T15:00:00.000Z");

    expect(s.mstate.actionItems).toHaveLength(2);
    expect(s.mstate.actionItems[0]).toMatchObject({ title: "Enviar plano de estudos", ownerText: "Ana", status: "PENDING" });
    expect(s.mstate.actionItems[0].dueDate?.toISOString()).toBe("2026-12-05T00:00:00.000Z");
    expect(s.mstate.actionItems[1]).toMatchObject({ dueDate: null, dueText: "próxima semana" });

    // Extração recebe ata e fonte MASCARADAS + o mapa desta execução.
    const [extractedId, extractInput] = s.runExtraction.mock.calls[0] as unknown as [
      string,
      { maskedNotes: string; maskedTranscription: string; piiMap: unknown },
    ];
    expect(extractedId).toBe("chk1");
    expect(extractInput.maskedNotes).toContain("[EMAIL_1]");
    expect(extractInput.maskedNotes).not.toContain("ana.silva@cliente.com.br");
    expect(extractInput.maskedTranscription).toBe(cp.transcription);
    // A ata gravada é DESMASCARADA (o gestor lê o dado real); a fonte não.
    expect(cp.notes).toContain("ana.silva@cliente.com.br");
    expect(s.mstate.notifications).toEqual([{ userId: "u-mgr", checkpointId: "chk1", kind: "ready" }]);
    // lease devolvido
    expect(s.state.connections.get("c-mgr")!.leaseOwner).toBeNull();
  });

  it("mascara e-mail, telefone, CPF e CNPJ ANTES da IA (o prompt nunca leva o dado)", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    expect(s.ai.complete).toHaveBeenCalledTimes(1);
    const [prompt, opts] = s.ai.complete.mock.calls[0] as unknown as [string, { system: string; json: boolean }];
    for (const raw of ["ana.silva@cliente.com.br", "98765-4321", "123.456.789-09", "12.345.678/0001-90"]) {
      expect(prompt).not.toContain(raw);
      expect(opts.system).not.toContain(raw);
    }
    expect(prompt).toContain("[EMAIL_1]");
    expect(opts.json).toBe(true);
    // Só a ata (saída da IA desmascarada) leva o dado real; a fonte guardada não.
    expect(s.mstate.saves[0].transcription).not.toContain("ana.silva@cliente.com.br");
    expect(s.mstate.saves[0].notes).toContain("ana.silva@cliente.com.br");
  });

  it("IA indisponível (null) degrada: grava texto-fonte mascarado + nota de origem, sem cards nem extração", async () => {
    const s = setup({ aiResponse: null });
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.saved).toBe(1);
    const cp = s.mstate.checkpoints.get("chk1")!;
    expect(cp.checkpointStatus).toBe("RECORDED");
    expect(cp.notes).toContain("sem resumo");
    expect(cp.transcription).toContain("[EMAIL_1]");
    expect(s.mstate.minutes.get("chk1")!.aiSummary).toBe(false);
    expect(s.mstate.actionItems).toHaveLength(0);
    expect(s.runExtraction).not.toHaveBeenCalled();
  });

  it("saída da IA fora do schema também degrada (nunca grava JSON inválido)", async () => {
    const s = setup({ aiResponse: '{"summary": 42}' });
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    expect(s.mstate.minutes.get("chk1")!.aiSummary).toBe(false);
    expect(s.mstate.actionItems).toHaveLength(0);
  });

  it("nenhuma candidata: fica SEARCHING, nada é gravado no checkpoint", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1", { subject: "Almoço", categories: [] }));
    const summary = await runMinutesRound(s.deps);
    expect(summary.none).toBe(1);
    expect(s.mstate.minutes.get("chk1")!.status).toBe("SEARCHING");
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
    expect(s.ai.complete).not.toHaveBeenCalled();
  });

  it("empate: AMBIGUOUS, nada escolhido sozinho, nenhuma candidata persistida, aviso uma vez", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.graphs["c-mgr"].addMessage(msg("m2", { receivedDateTime: "2026-11-25T10:00:00Z" }));
    const first = await runMinutesRound(s.deps);
    expect(first.ambiguous).toBe(1);
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "AMBIGUOUS", internetMessageId: null });
    expect(s.mstate.saves).toHaveLength(0);
    expect(s.ai.complete).not.toHaveBeenCalled();
    expect(s.graphs["c-mgr"].calls.mail.some((c) => c.op === "body")).toBe(false);
    expect(s.mstate.notifications).toEqual([{ userId: "u-mgr", checkpointId: "chk1", kind: "choice" }]);

    // AMBIGUOUS não volta para o job; a busca manual reavalia sem repetir o aviso.
    expect((await runMinutesRound(s.deps)).checkpoints).toBe(0);
    await searchMinutesNow("chk1", "u-mgr", s.deps);
    expect(s.mstate.notifications).toHaveLength(1);
  });

  it("gestor escolhe a mensagem no empate → ata gravada com ela", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.graphs["c-mgr"].addMessage(msg("m2", { receivedDateTime: "2026-11-25T10:00:00Z" }));
    await runMinutesRound(s.deps);
    const choices = await listMinutesChoices("chk1", "u-mgr", s.deps);
    expect(choices.ok && choices.value.map((c) => c.messageId).sort()).toEqual(["m1", "m2"]);
    // listar não persiste nada
    expect(s.mstate.saves).toHaveLength(0);
    const chosen = await chooseMinutesMessage("chk1", "m2", "u-mgr", s.deps);
    expect(chosen).toEqual({ ok: true, value: "saved" });
    expect(s.mstate.minutes.get("chk1")!.internetMessageId).toBe("<m2@mail>");
  });

  it("escolha de mensagem que não é candidata desta reunião é recusada", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m9", { subject: "Proposta comercial", toRecipients: [] }));
    const chosen = await chooseMinutesMessage("chk1", "m9", "u-mgr", s.deps);
    expect(chosen).toEqual({ ok: true, value: "not_candidate" });
    expect(await chooseMinutesMessage("chk1", "nao-existe", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_candidate" });
    expect(s.mstate.saves).toHaveLength(0);
  });

  it("idempotência: um internetMessageId alimenta no máximo um checkpoint", async () => {
    const s = setup();
    // Segundo 1:1 com o mesmo assunto/consultor, no dia seguinte.
    s.mstate.checkpoints.set(
      "chk2",
      checkpoint({
        checkpointId: "chk2",
        eventStartAt: new Date("2026-11-25T13:00:00Z"),
        eventEndAt: new Date("2026-11-25T13:30:00Z"),
      }),
    );
    s.graphs["c-mgr"].addMessage(msg("m1", { receivedDateTime: "2026-11-25T15:00:00Z" }));
    await runMinutesRound(s.deps);
    const ids = [...s.mstate.minutes.values()].map((r) => r.internetMessageId).filter(Boolean);
    expect(ids).toEqual(["<m1@mail>"]);
    // O outro checkpoint continua procurando (não reusa a mesma mensagem).
    expect([...s.mstate.minutes.values()].map((r) => r.status).sort()).toEqual(["DONE", "SEARCHING"]);

    // Reprocessar não duplica nada.
    await searchMinutesNow("chk2", "u-mgr", s.deps);
    expect(s.mstate.actionItems.filter((a) => a.checkpointId === "chk2")).toHaveLength(0);
  });

  it("corrida: o banco recusa o internetMessageId já usado → duplicate, sem tocar o checkpoint", async () => {
    const s = setup();
    s.mstate.minutes.set("outro", {
      status: "DONE",
      internetMessageId: "<m1@mail>",
      webLink: null,
      receivedAt: null,
      aiSummary: true,
      attempts: 1,
      lastError: null,
      attachmentsUsed: 0,
      attachmentsSkipped: 0,
    });
    s.graphs["c-mgr"].addMessage(msg("m1"));
    // A seleção já descarta o id usado; força a escolha manual para provar o guard do store.
    const chosen = await chooseMinutesMessage("chk1", "m1", "u-mgr", s.deps);
    expect(chosen).toEqual({ ok: true, value: "duplicate" });
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
  });

  it("gestor editou o rascunho durante a geração: nada é sobrescrito", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.ai.complete.mockImplementationOnce(async () => {
      s.mstate.checkpoints.get("chk1")!.notes = "notas do gestor";
      return AI_OK;
    });
    await runMinutesRound(s.deps);
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBe("notas do gestor");
    expect(s.mstate.actionItems).toHaveLength(0);
  });
});

describe("só a conta do GESTOR alimenta ata", () => {
  it("a caixa do consultor nunca é consultada, mesmo conectada com Mail.Read", async () => {
    const s = setup();
    s.graphs["c-ana"].addMessage(msg("ma"));
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    await searchMinutesNow("chk1", "u-mgr", s.deps);
    expect(s.graphs["c-ana"].calls.mail).toHaveLength(0);
    expect(s.state.connections.get("c-ana")!.leaseOwner).toBeNull();
    expect(s.mstate.minutes.get("chk1")!.internetMessageId).toBe("<m1@mail>");
  });

  it("consultor (ou ADMIN que não é o gestor) não aciona a busca nem lê caixa alguma", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    expect(await searchMinutesNow("chk1", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await searchMinutesNow("chk1", "u-admin", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await listMinutesChoices("chk1", "u-admin", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await chooseMinutesMessage("chk1", "m1", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    for (const g of Object.values(s.graphs)) expect(g.calls.mail).toHaveLength(0);
  });

  it("gestor que perdeu o papel de quem registra checkpoint: nada é lido", async () => {
    const s = setup({ managerRoles: ["CONSULTANT"] });
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.saved).toBe(0);
    expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
  });

  it("gestor que é o próprio consultor do checkpoint: ignorado", async () => {
    const s = setup();
    s.state.users.get("u-mgr")!.consultantId = "cons-ana";
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.saved).toBe(0);
    expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
  });

  it("conexão sem Mail.Read (só M1): pula sem chamar o Graph", async () => {
    const s = setup();
    s.state.connections.get("c-mgr")!.scopes = ["openid", "Calendars.Read"];
    s.graphs["c-mgr"].addMessage(msg("m1"));
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_connected" });
    expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
  });
});

describe("lease e erros da conexão", () => {
  it("lease de outra rodada ativo → busy, sem tocar o Graph", async () => {
    const s = setup();
    const conn = s.state.connections.get("c-mgr")!;
    conn.leaseOwner = "job:outro";
    conn.leaseUntil = new Date(NOW.getTime() + 60_000);
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.busy).toBe(1);
    expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "busy" });
  });

  it("401 persistente (reauth) → conexão REAUTH_REQUIRED e lease liberado", async () => {
    const s = setup();
    s.graphs["c-mgr"].failNext(new GraphError("reauth", "x", { status: 401 }));
    const summary = await runMinutesRound(s.deps);
    expect(summary.errors).toBe(1);
    expect(s.state.connections.get("c-mgr")!.status).toBe("REAUTH_REQUIRED");
    expect(s.state.connections.get("c-mgr")!.leaseOwner).toBeNull();
    // Log só com código.
    const log = s.state.logs.find((l) => l.operation === "minutes.mail")!;
    expect(log.error).toBe("reauth:401");
  });

  it("logs só levam contadores e códigos (nunca assunto, e-mail ou corpo)", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    const dump = JSON.stringify(s.state.logs);
    for (const leak of ["1:1 Ana", "ana@jump.com.br", "gestor@jump.com.br", "Combinamos", "<m1@mail>"]) {
      expect(dump).not.toContain(leak);
    }
  });
});

describe("anexos", () => {
  it("anexo grande, inline ou de outro tipo é ignorado sem baixar", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        attachments: [
          { id: "a1", name: "ata.pdf", contentType: "application/pdf", size: 11 * 1024 * 1024, isInline: false, bytes: new Uint8Array() },
          { id: "a2", name: "logo.png", contentType: "image/png", size: 100, isInline: true, bytes: new Uint8Array() },
          { id: "a3", name: "planilha.xlsx", contentType: "application/vnd.ms-excel", size: 100, isInline: false, bytes: new Uint8Array() },
        ],
      }),
    );
    await runMinutesRound(s.deps);
    expect(s.graphs["c-mgr"].calls.mail.filter((c) => c.op === "attachment")).toHaveLength(0);
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "DONE", attachmentsUsed: 0, attachmentsSkipped: 2 });
  });

  it("e-mail sem corpo e com PDF escaneado: FAILED (não suportado), nada gravado no checkpoint", async () => {
    const s = setup();
    const scanned = Buffer.from(
      "%PDF-1.4\n1 0 obj << /Type /XObject /Subtype /Image /Width 10 /Height 10 /Length 3 >>\nstream\nabc\nendstream\nendobj\n%%EOF",
      "latin1",
    );
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        body: { contentType: "text", content: "", uniqueContentType: null, uniqueContent: null },
        attachments: [
          { id: "a1", name: "ata.pdf", contentType: "application/pdf", size: scanned.length, isInline: false, bytes: new Uint8Array(scanned) },
        ],
      }),
    );
    await runMinutesRound(s.deps);
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "FAILED", lastError: "empty_source" });
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
    expect(s.ai.complete).not.toHaveBeenCalled();
  });
});
