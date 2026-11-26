import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { AiTextProvider } from "@/lib/ai/provider";
import { createFakeGraphClient, type FakeGraph, type FakeMessage } from "../graph/fake";
import { GraphError } from "../graph/errors";
import type { M365ConnectionRecord } from "../store";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { createMemoryMinutesStore } from "../testing/memory-minutes-store";
import { MAX_SOURCE_CHARS, TRUNCATION_MARKER } from "./generate";
import {
  chooseMinutesMessage,
  listMinutesChoices,
  runMinutesRound,
  searchMinutesNow,
  type MinutesDeps,
} from "./run";
import type { MinutesCheckpoint } from "./store";

/**
 * QA M2 — atas por e-mail, cenários adversariais (complementa `run.test.ts`).
 * Graph fake por conexão, IA mockada, store em memória. Os `it.fails`
 * documentam achados (ver "Fase M2 — testes" no ANDAMENTO).
 */

const NOW = new Date("2026-11-26T15:00:00.000Z");
const M2 = ["openid", "profile", "offline_access", "User.Read", "Calendars.Read", "Mail.Read"];

const AI_OK = JSON.stringify({
  summary: "Conversa de acompanhamento.",
  decisions: ["Manter a alocação"],
  attentionPoints: [],
  actions: [{ title: "Enviar plano", owner: "Ana", dueDate: "2026-12-05", quote: "vou mandar o plano" }],
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
      content: "corpo",
      uniqueContentType: "text",
      uniqueContent: "Combinamos manter a alocação atual e revisar metas no próximo mês.",
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

function setup(opts: { aiResponse?: string | null } = {}) {
  const { store, state } = createMemoryStore();
  const user = (id: string, email: string, roles: string[], consultantId: string | null = null) =>
    state.users.set(id, { user: { id, name: id, email, roles: roles as never }, consultantId });
  user("u-mgr", "gestor@jump.com.br", ["PROJECT_MANAGER"]);
  user("u-ana", "ana@jump.com.br", ["CONSULTANT"], "cons-ana");
  user("u-bruno", "bruno@jump.com.br", ["CONSULTANT"], "cons-bruno");
  user("u-admin", "admin@jump.com.br", ["ADMIN"]);
  user("u-people", "people@jump.com.br", ["PEOPLE"]);
  for (const [cid, uid, mail] of [
    ["c-mgr", "u-mgr", "gestor@jump.com.br"],
    ["c-ana", "u-ana", "ana@jump.com.br"],
    ["c-admin", "u-admin", "admin@jump.com.br"],
    ["c-people", "u-people", "people@jump.com.br"],
  ] as const) {
    addConnection(state, { id: cid, userId: uid, mailbox: mail, scopes: M2 });
  }

  const { minutes, state: mstate } = createMemoryMinutesStore();
  for (const [uid, cid] of [
    ["u-mgr", "c-mgr"],
    ["u-ana", "c-ana"],
    ["u-admin", "c-admin"],
    ["u-people", "c-people"],
  ] as const) {
    mstate.connectionsByUser.set(uid, cid);
  }
  mstate.consultantEmails.set("cons-ana", ["ana@jump.com.br"]);
  mstate.consultantEmails.set("cons-bruno", ["bruno@jump.com.br"]);
  mstate.checkpoints.set("chk1", checkpoint());

  const graphs: Record<string, FakeGraph> = {
    "c-mgr": createFakeGraphClient(),
    "c-ana": createFakeGraphClient(),
    "c-admin": createFakeGraphClient(),
    "c-people": createFakeGraphClient(),
  };
  const ai = {
    complete: vi.fn<(prompt: string, options?: unknown) => Promise<string | null>>(async () =>
      opts.aiResponse === undefined ? AI_OK : opts.aiResponse,
    ),
    completeWithDocument: vi.fn(async () => null),
  } satisfies AiTextProvider;
  const runExtraction = vi.fn<(checkpointId: string) => Promise<string>>(async () => "done");
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

type Setup = ReturnType<typeof setup>;

function otherMailCalls(s: Setup) {
  return Object.entries(s.graphs)
    .filter(([cid]) => cid !== "c-mgr")
    .flatMap(([, g]) => g.calls.mail);
}

function addBrunoCheckpoint(s: Setup, o: Partial<MinutesCheckpoint> = {}) {
  s.mstate.checkpoints.set(
    "chk-bruno",
    checkpoint({ checkpointId: "chk-bruno", consultantId: "cons-bruno", eventSubject: "1:1 Bruno", ...o }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("só a caixa do GESTOR do checkpoint é consultada", () => {
  it("PEOPLE e ADMIN: buscar, listar e escolher → forbidden, sem lease nem chamada a NENHUMA caixa", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.graphs["c-people"].addMessage(msg("m1"));
    for (const actor of ["u-people", "u-admin"]) {
      expect(await searchMinutesNow("chk1", actor, s.deps)).toEqual({ ok: false, code: "forbidden" });
      expect(await listMinutesChoices("chk1", actor, s.deps)).toEqual({ ok: false, code: "forbidden" });
      expect(await chooseMinutesMessage("chk1", "m1", actor, s.deps)).toEqual({ ok: false, code: "forbidden" });
    }
    for (const g of Object.values(s.graphs)) expect(g.calls.mail).toHaveLength(0);
    for (const c of s.state.connections.values()) expect(c.leaseOwner).toBeNull();
    expect(s.mstate.saves).toHaveLength(0);
    expect(s.mstate.minutes.size).toBe(0);
  });

  it("consultor avaliado escolhendo um e-mail da PRÓPRIA caixa → forbidden; caixa dele nunca lida", async () => {
    const s = setup();
    s.graphs["c-ana"].addMessage(msg("ma"));
    expect(await chooseMinutesMessage("chk1", "ma", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(await searchMinutesNow("chk1", "u-ana", s.deps)).toEqual({ ok: false, code: "forbidden" });
    expect(s.graphs["c-ana"].calls.mail).toHaveLength(0);
  });

  it("job: a caixa do consultor (e de ADMIN/PEOPLE conectados) nunca é consultada, nem com e-mail casando", async () => {
    const s = setup();
    for (const cid of ["c-ana", "c-admin", "c-people"]) s.graphs[cid].addMessage(msg(`x-${cid}`, { categories: ["JumpFlow"] }));
    await runMinutesRound(s.deps);
    expect(otherMailCalls(s)).toHaveLength(0);
    expect(s.graphs["c-mgr"].calls.mail.filter((c) => c.op === "find")).toHaveLength(2);
  });

  it("checkpoint sem gestor (managerUserId nulo) → nenhuma caixa é lida", async () => {
    const s = setup();
    s.mstate.checkpoints.set("chk1", checkpoint({ managerUserId: null }));
    s.graphs["c-mgr"].addMessage(msg("m1"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.managers).toBe(0);
    for (const g of Object.values(s.graphs)) expect(g.calls.mail).toHaveLength(0);
  });

  it("defesa em profundidade: se o store devolvesse a conexão de OUTRO usuário, nada é lido", async () => {
    const s = setup();
    // Simula um bug de mapeamento userId → conexão (apontando para a caixa da consultora).
    s.mstate.connectionsByUser.set("u-mgr", "c-ana");
    s.graphs["c-ana"].addMessage(msg("ma"));
    const summary = await runMinutesRound(s.deps);
    expect(summary.skipped).toBe(1);
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_connected" });
    expect(s.graphs["c-ana"].calls.mail).toHaveLength(0);
    expect(s.state.connections.get("c-ana")!.leaseOwner).toBeNull();
  });

  it("gestor com conexão PAUSED/REAUTH_REQUIRED não é lido", async () => {
    for (const status of ["PAUSED", "REAUTH_REQUIRED", "DISCONNECTED", "ERROR"] as const) {
      const s = setup();
      s.state.connections.get("c-mgr")!.status = status;
      s.graphs["c-mgr"].addMessage(msg("m1"));
      await runMinutesRound(s.deps);
      expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
    }
  });
});

describe("seleção da candidata", () => {
  it("dois 1:1 do MESMO gestor: e-mail com categoria de um consultor nunca alimenta o do outro", async () => {
    const s = setup();
    addBrunoCheckpoint(s);
    // Assunto neutro: só categoria + destinatário distinguem.
    s.graphs["c-mgr"].addMessage(msg("m-ana", { subject: "Resumo", categories: ["JumpFlow"] }));
    s.graphs["c-mgr"].addMessage(
      msg("m-bruno", {
        subject: "Resumo",
        categories: ["JumpFlow"],
        toRecipients: [{ emailAddress: { address: "bruno@jump.com.br" } }],
        receivedDateTime: "2026-11-24T16:00:00Z",
      }),
    );
    await runMinutesRound(s.deps);
    expect(s.mstate.minutes.get("chk1")!.internetMessageId).toBe("<m-ana@mail>");
    expect(s.mstate.minutes.get("chk-bruno")!.internetMessageId).toBe("<m-bruno@mail>");
  });

  it("categoria JumpFlow sozinha (sem consultor e sem assunto do evento) não casa: SEARCHING, nada lido nem gravado", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        subject: "Proposta comercial",
        categories: ["JumpFlow"],
        toRecipients: [{ emailAddress: { address: "cliente@externo.com" } }],
      }),
    );
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "none" });
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "SEARCHING", internetMessageId: null });
    expect(s.graphs["c-mgr"].calls.mail.some((c) => c.op === "body")).toBe(false);
    expect(s.ai.complete).not.toHaveBeenCalled();
  });

  it("e-mail de fora enviado ao gestor com o assunto do evento é elegível (gestor em to) — sem consultor, perde para quem tem", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m-ext", {
        subject: "RE: 1:1 Ana",
        from: { emailAddress: { address: "alguem@externo.com" } },
        toRecipients: [{ emailAddress: { address: "gestor@jump.com.br" } }],
        receivedDateTime: "2026-11-25T09:00:00Z",
      }),
    );
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    expect(s.mstate.minutes.get("chk1")!.internetMessageId).toBe("<m1@mail>");
  });

  it("empate: AMBIGUOUS sem ler corpo/anexo de nenhuma candidata e sem persistir nada delas", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1", { subject: "Ata: 1:1 Ana — versão A" }));
    s.graphs["c-mgr"].addMessage(msg("m2", { subject: "Ata: 1:1 Ana — versão B", receivedDateTime: "2026-11-25T10:00:00Z" }));
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "ambiguous" });
    expect(s.graphs["c-mgr"].calls.mail.map((c) => c.op)).toEqual(["find", "find"]);
    expect(s.ai.complete).not.toHaveBeenCalled();
    const dump = JSON.stringify({
      minutes: [...s.mstate.minutes.entries()],
      saves: s.mstate.saves,
      items: s.mstate.actionItems,
      cps: [...s.mstate.checkpoints.values()],
      logs: s.state.logs,
      notes: s.mstate.notifications,
    });
    for (const leak of ["m1", "m2", "versão A", "versão B", "<m1@mail>", "gestor@jump.com.br", "outlook.office365.com"]) {
      expect(dump).not.toContain(leak);
    }
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "AMBIGUOUS", internetMessageId: null, webLink: null });
    // Listar as candidatas também não persiste nem lê corpo.
    await listMinutesChoices("chk1", "u-mgr", s.deps);
    expect(s.graphs["c-mgr"].calls.mail.some((c) => c.op === "body" || c.op === "attachments")).toBe(false);
    expect(s.mstate.saves).toHaveLength(0);
  });

  it("AMBIGUOUS não é reprocessado sozinho pelo job (espera a escolha do gestor)", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.graphs["c-mgr"].addMessage(msg("m2", { receivedDateTime: "2026-11-25T10:00:00Z" }));
    await runMinutesRound(s.deps);
    const finds = s.graphs["c-mgr"].calls.mail.length;
    await runMinutesRound(s.deps);
    expect(s.graphs["c-mgr"].calls.mail.length).toBe(finds);
    expect(s.mstate.notifications.filter((n) => n.kind === "choice")).toHaveLength(1);
  });
});

describe("escolha manual revalidada", () => {
  it("id da ata de OUTRO checkpoint (outro consultor) é recusado para este", async () => {
    const s = setup();
    addBrunoCheckpoint(s);
    s.graphs["c-mgr"].addMessage(
      msg("m-bruno", { subject: "Ata: 1:1 Bruno", toRecipients: [{ emailAddress: { address: "bruno@jump.com.br" } }] }),
    );
    expect(await chooseMinutesMessage("chk1", "m-bruno", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_candidate" });
    expect(s.mstate.saves).toHaveLength(0);
    expect(s.graphs["c-mgr"].calls.mail.some((c) => c.op === "body")).toBe(false);
  });

  it("id já usado por outro checkpoint → duplicate, sem ler corpo nem tocar o rascunho", async () => {
    const s = setup();
    addBrunoCheckpoint(s, { eventSubject: "1:1 Ana" , consultantId: "cons-ana" });
    s.graphs["c-mgr"].addMessage(msg("m1"));
    expect(await chooseMinutesMessage("chk-bruno", "m1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    const bodyCalls = s.graphs["c-mgr"].calls.mail.filter((c) => c.op === "body").length;
    expect(await chooseMinutesMessage("chk1", "m1", "u-mgr", s.deps)).toEqual({ ok: true, value: "duplicate" });
    expect(s.graphs["c-mgr"].calls.mail.filter((c) => c.op === "body").length).toBe(bodyCalls);
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
  });

  it("id adulterado: convite/resposta de reunião, rascunho ou fora da janela → not_candidate", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("inv", { "@odata.type": "#microsoft.graph.eventMessageRequest" }));
    s.graphs["c-mgr"].addMessage(msg("acc", { subject: "Aceito: 1:1 Ana" }));
    s.graphs["c-mgr"].addMessage(msg("draft", { isDraft: true }));
    s.graphs["c-mgr"].addMessage(msg("old", { receivedDateTime: "2026-11-20T10:00:00Z" }));
    for (const id of ["inv", "acc", "draft", "old", "../../users/outro/messages/x", ""]) {
      expect(await chooseMinutesMessage("chk1", id, "u-mgr", s.deps)).toEqual({ ok: true, value: "not_candidate" });
    }
    expect(s.mstate.saves).toHaveLength(0);
  });

  it("checkpoint que já tem ata (ou não é mais DRAFT) → not_eligible, sem tocar o Graph", async () => {
    const s = setup();
    s.mstate.checkpoints.set("chk1", checkpoint({ checkpointStatus: "RECORDED", notes: "ata" }));
    s.graphs["c-mgr"].addMessage(msg("m1"));
    expect(await chooseMinutesMessage("chk1", "m1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_eligible" });
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "not_eligible" });
    expect(s.graphs["c-mgr"].calls.mail).toHaveLength(0);
  });
});

describe("idempotência e corrida", () => {
  it("o mesmo e-mail endereçado a dois consultores (assunto igual) alimenta UM checkpoint só", async () => {
    const s = setup();
    s.mstate.checkpoints.set("chk1", checkpoint({ eventSubject: "Checkpoint semanal" }));
    addBrunoCheckpoint(s, { eventSubject: "Checkpoint semanal" });
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        subject: "Checkpoint semanal",
        toRecipients: [{ emailAddress: { address: "ana@jump.com.br" } }, { emailAddress: { address: "bruno@jump.com.br" } }],
      }),
    );
    await runMinutesRound(s.deps);
    await runMinutesRound(s.deps);
    const used = [...s.mstate.minutes.values()].filter((r) => r.internetMessageId === "<m1@mail>");
    expect(used).toHaveLength(1);
    expect(s.ai.complete).toHaveBeenCalledTimes(1);
  });

  it("internetMessageId com caixa diferente (Enviados × Entrada) conta como o mesmo e-mail", async () => {
    const s = setup();
    addBrunoCheckpoint(s, { eventSubject: "1:1 Ana", consultantId: "cons-ana" });
    s.graphs["c-mgr"].addMessage(msg("m1", { internetMessageId: "<ABC@Mail>" }));
    await runMinutesRound(s.deps);
    s.graphs["c-mgr"].addMessage(msg("m1-sent", { internetMessageId: "<abc@mail>" }));
    await runMinutesRound(s.deps);
    const ids = [...s.mstate.minutes.values()].map((r) => r.internetMessageId).filter(Boolean);
    expect(ids).toEqual(["<abc@mail>"]);
  });

  it("rodar de novo depois de DONE não chama IA, não duplica cards nem avisa de novo", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    await runMinutesRound(s.deps);
    expect(s.ai.complete).toHaveBeenCalledTimes(1);
    expect(s.mstate.actionItems).toHaveLength(1);
    expect(s.mstate.notifications.filter((n) => n.kind === "ready")).toHaveLength(1);
  });

  it("gestor edita durante a geração: nada sobrescrito, sem DONE, sem aviso, sem extração", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.ai.complete.mockImplementationOnce(async () => {
      s.mstate.checkpoints.get("chk1")!.transcription = "transcrição colada pelo gestor";
      return AI_OK;
    });
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "checkpoint_changed" });
    const cp = s.mstate.checkpoints.get("chk1")!;
    expect(cp.transcription).toBe("transcrição colada pelo gestor");
    expect(cp.notes).toBeNull();
    expect(cp.checkpointStatus).toBe("DRAFT");
    expect(s.mstate.minutes.get("chk1")?.status).not.toBe("DONE");
    expect(s.mstate.notifications).toHaveLength(0);
    expect(s.runExtraction).not.toHaveBeenCalled();
    expect(s.mstate.actionItems).toHaveLength(0);
  });

  it("gestor arquivou o rascunho durante a geração: nada é gravado", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.ai.complete.mockImplementationOnce(async () => {
      s.mstate.checkpoints.get("chk1")!.checkpointStatus = "ARCHIVED";
      return AI_OK;
    });
    await runMinutesRound(s.deps);
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
    expect(s.mstate.actionItems).toHaveLength(0);
  });
});

describe("mascaramento ANTES da IA", () => {
  const PII = [
    "joao.pereira@cliente.com.br",
    "MARIA@EMPRESA.COM",
    "+55 11 98765-4321",
    "(21) 3456-7890",
    "12345678909",
    "987.654.321-00",
    "12.345.678/0001-90",
    "98765432000110",
  ];

  async function docx(text: string): Promise<Uint8Array> {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
    return zip.generateAsync({ type: "uint8array" });
  }

  function pdf(text: string): Uint8Array {
    const content = deflateSync(Buffer.from(`BT /F1 12 Tf 72 700 Td (${text}) Tj ET`, "latin1"));
    const objs = [
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n",
      "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj\n",
    ];
    return new Uint8Array(
      Buffer.concat([
        Buffer.from(`%PDF-1.5\n${objs.join("")}4 0 obj << /Filter /FlateDecode /Length ${content.length} >>\nstream\n`, "latin1"),
        content,
        Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
      ]),
    );
  }

  it("corpo HTML + DOCX + PDF com e-mail/telefone/CPF/CNPJ: nada disso no prompt, no system, nas notas ou na transcrição", async () => {
    const s = setup();
    const docxBytes = await docx(`Contato DOCX: ${PII[0]} e ${PII[2]}`);
    const pdfBytes = pdf(`Contato PDF: ${PII[4]} ${PII[6]} ${PII[7]}`);
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        body: {
          contentType: "html",
          content: "",
          uniqueContentType: "html",
          uniqueContent: `<p>Ata.</p><div>Falar com ${PII[1]} no ${PII[3]}; CPF ${PII[5]}.</div>`,
        },
        attachments: [
          { id: "a1", name: "ata.docx", contentType: null, size: docxBytes.length, isInline: false, bytes: docxBytes },
          { id: "a2", name: "ata.pdf", contentType: "application/pdf", size: pdfBytes.length, isInline: false, bytes: pdfBytes },
        ],
      }),
    );
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    const [prompt, opts] = s.ai.complete.mock.calls[0] as [string, { system: string }];
    expect(prompt).toContain("Contato DOCX");
    expect(prompt).toContain("Contato PDF");
    const cp = s.mstate.checkpoints.get("chk1")!;
    for (const value of PII) {
      for (const where of [prompt, opts.system, cp.notes ?? "", cp.transcription ?? "", JSON.stringify(s.mstate.saves)]) {
        expect(where).not.toContain(value);
        expect(where.toLowerCase()).not.toContain(value.toLowerCase());
      }
    }
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ attachmentsUsed: 2, attachmentsSkipped: 0 });
  });

  // ACHADO (menor): o corte 70/30 acontece ANTES da máscara; um dado pessoal
  // que cruza o ponto de corte fica pela metade e não casa a regex — o
  // fragmento ("joao.pereir") vai para a IA e para `transcription`.
  it("dado pessoal na fronteira do corte 70/30 não vaza fragmento", async () => {
    const s = setup();
    const head = Math.floor((MAX_SOURCE_CHARS - TRUNCATION_MARKER.length) * 0.7);
    // "Corpo do e-mail:\n" é o prefixo do texto-fonte.
    const prefix = "Corpo do e-mail:\n".length;
    const email = "joao.pereira@cliente.com.br";
    const body = `${"a".repeat(head - prefix - 12)} ${email} ${"b ".repeat(40_000)}`;
    s.graphs["c-mgr"].addMessage(
      msg("m1", { body: { contentType: "text", content: "", uniqueContentType: "text", uniqueContent: body } }),
    );
    await searchMinutesNow("chk1", "u-mgr", s.deps);
    const [prompt] = s.ai.complete.mock.calls[0] as [string];
    expect(prompt).toContain(TRUNCATION_MARKER.trim());
    expect(prompt).not.toMatch(/joao\.pere/);
  });

  // ACHADO (menor): CPF escrito com espaços ou só com pontos não é mascarado.
  it("CPF com espaços/pontos (123 456 789 09, 123.456.789.09) também é mascarado", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        body: { contentType: "text", content: "", uniqueContentType: "text", uniqueContent: "CPF 123 456 789 09 e 123.456.789.09" },
      }),
    );
    await searchMinutesNow("chk1", "u-mgr", s.deps);
    const [prompt] = s.ai.complete.mock.calls[0] as [string];
    expect(prompt).not.toContain("123 456 789 09");
    expect(prompt).not.toContain("123.456.789.09");
  });
});

describe("IA indisponível ou inválida degrada sem cards", () => {
  for (const [label, response] of [
    ["JSON inválido", "isto não é json {"],
    ["JSON vazio", "{}"],
    ["resumo vazio", JSON.stringify({ summary: "   ", actions: [{ title: "x" }] })],
    ["ações fora do schema", JSON.stringify({ summary: "ok", actions: [{ title: "" }] })],
    ["string vazia", ""],
  ] as const) {
    it(`${label}: RECORDED com fonte mascarada + nota de origem; sem cards e sem extração`, async () => {
      const s = setup({ aiResponse: response });
      s.graphs["c-mgr"].addMessage(msg("m1"));
      expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved_without_ai" });
      const cp = s.mstate.checkpoints.get("chk1")!;
      expect(cp.checkpointStatus).toBe("RECORDED");
      expect(cp.notes).toContain("sem resumo");
      expect(cp.transcription).toContain("Combinamos");
      expect(s.mstate.actionItems).toHaveLength(0);
      expect(s.runExtraction).not.toHaveBeenCalled();
      expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "DONE", aiSummary: false });
    });
  }

  it("provider que LANÇA: nada gravado, segue procurando, lease liberado, rodada não cai", async () => {
    const s = setup();
    addBrunoCheckpoint(s);
    s.graphs["c-mgr"].addMessage(msg("m1"));
    s.graphs["c-mgr"].addMessage(
      msg("m-bruno", { subject: "Ata: 1:1 Bruno", toRecipients: [{ emailAddress: { address: "bruno@jump.com.br" } }] }),
    );
    s.ai.complete.mockImplementationOnce(async () => {
      throw new Error("provider down");
    });
    const summary = await runMinutesRound(s.deps);
    expect(summary).toMatchObject({ failed: 1, saved: 1 });
    expect(s.mstate.checkpoints.get("chk1")!.notes).toBeNull();
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "SEARCHING" });
    expect(s.state.connections.get("c-mgr")!.leaseOwner).toBeNull();
  });

  it("extração que lança não desfaz a ata nem impede o aviso", async () => {
    const s = setup();
    s.runExtraction.mockRejectedValueOnce(new Error("boom"));
    s.graphs["c-mgr"].addMessage(msg("m1"));
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(s.mstate.checkpoints.get("chk1")!.checkpointStatus).toBe("RECORDED");
    expect(s.mstate.notifications).toEqual([{ userId: "u-mgr", checkpointId: "chk1", kind: "ready" }]);
  });
});

describe("corpo encaminhado", () => {
  // ACHADO (importante): a regra de assunto aceita ENC:/FW: (ata encaminhada),
  // mas `cleanEmailBody` corta tudo a partir do cabeçalho "De:/Enviado:" (ou
  // "Forwarded message") — o conteúdo encaminhado, que É a ata, é descartado.
  it("ata ENCAMINHADA (ENC:) aproveita o conteúdo encaminhado", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        subject: "ENC: 1:1 Ana",
        body: {
          contentType: "text",
          content: "",
          uniqueContentType: "text",
          uniqueContent:
            "Segue a ata.\n\n________________________________\nDe: Ana\nEnviado: segunda-feira, 24 de novembro de 2026 11:00\nPara: Gestor\nAssunto: 1:1 Ana\n\nDecisões: manter alocação; Ana enviará o plano até 05/12.",
        },
      }),
    );
    await searchMinutesNow("chk1", "u-mgr", s.deps);
    expect(s.mstate.checkpoints.get("chk1")!.transcription ?? "").toContain("manter alocação");
  });
});

describe("e-mail bruto nunca persistido — só metadados de origem", () => {
  it("origem gravada = internetMessageId, webLink, recebido em; nada de assunto/remetente/corpo citado", async () => {
    const s = setup();
    s.graphs["c-mgr"].addMessage(
      msg("m1", {
        subject: "Ata: 1:1 Ana — SEGREDO-NO-ASSUNTO",
        from: { emailAddress: { name: "Remetente Secreto", address: "remetente.secreto@jump.com.br" } },
        body: {
          contentType: "text",
          content: "CORPO-COMPLETO-COM-HISTORICO",
          uniqueContentType: "text",
          // Correção M2: texto próprio suficiente (≥ MIN_SOURCE_CHARS); com texto
          // próprio curto o bloco citado passa a ser preservado (ata encaminhada).
          uniqueContent:
            "Parte nova da ata: combinamos manter a alocação e revisar metas.\n\nDe: Fulano\nEnviado: ontem\nHISTORICO-CITADO",
        },
      }),
    );
    await runMinutesRound(s.deps);
    expect(Object.keys(s.mstate.saves[0].source).sort()).toEqual(["internetMessageId", "receivedAt", "webLink"]);
    const dump = JSON.stringify({
      saves: s.mstate.saves,
      minutes: [...s.mstate.minutes.entries()],
      cps: [...s.mstate.checkpoints.values()],
      logs: s.state.logs,
      notifications: s.mstate.notifications,
    });
    for (const leak of ["SEGREDO-NO-ASSUNTO", "Remetente Secreto", "remetente.secreto", "CORPO-COMPLETO", "HISTORICO-CITADO"]) {
      expect(dump).not.toContain(leak);
    }
  });

  it("webLink fora do host da Microsoft (ou não-https) não é gravado", async () => {
    for (const webLink of ["javascript:alert(1)", "http://outlook.office365.com/owa/?x", "https://evil.example.com/owa", "https://office365.com.evil.io/x"]) {
      const s = setup();
      s.graphs["c-mgr"].addMessage(msg("m1", { webLink }));
      await runMinutesRound(s.deps);
      expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "DONE", webLink: null });
    }
  });
});

describe("anexos na rodada", () => {
  function pdfAttachment(id: string, bytes: Uint8Array) {
    return { id, name: `${id}.pdf`, contentType: "application/pdf", size: bytes.length || 1, isInline: false, bytes };
  }

  it("8 anexos PDF: só 3 baixados; PDF malformado não derruba e a ata sai do corpo", async () => {
    const s = setup();
    const junk = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << /Length 99999 >> stream\n\u0000\u0001", "latin1"));
    s.graphs["c-mgr"].addMessage(
      msg("m1", { attachments: Array.from({ length: 8 }, (_, i) => pdfAttachment(`a${i}`, junk)) }),
    );
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(s.graphs["c-mgr"].calls.mail.filter((c) => c.op === "attachment")).toHaveLength(3);
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ attachmentsUsed: 0, attachmentsSkipped: 8 });
    expect(s.mstate.checkpoints.get("chk1")!.transcription).toContain("Combinamos");
  });

  it("metadado de tamanho mentiroso: bytes > 10 MB baixados são descartados (contados como não suportados)", async () => {
    const s = setup();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    s.graphs["c-mgr"].addMessage(msg("m1", { attachments: [{ ...pdfAttachment("a1", big), size: 100 }] }));
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ attachmentsUsed: 0, attachmentsSkipped: 1 });
  });

  // ACHADO (menor): um anexo que some entre a listagem e o download (404) faz
  // a ata inteira falhar (SEARCHING + retry), embora o corpo tenha a ata.
  it("anexo que dá 404 no download é pulado e a ata sai do corpo", async () => {
    const s = setup();
    const message = msg("m1", { attachments: [pdfAttachment("a1", new Uint8Array([1]))] });
    s.graphs["c-mgr"].addMessage(message);
    const graph = s.graphs["c-mgr"];
    graph.getAttachment = async () => {
      throw new GraphError("not_found", "Graph respondeu 404.", { status: 404 });
    };
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
  });
});
