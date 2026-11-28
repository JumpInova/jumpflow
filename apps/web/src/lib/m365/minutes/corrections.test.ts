import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { AiTextProvider } from "@/lib/ai/provider";
import { createFakeGraphClient, type FakeGraph, type FakeMessage } from "../graph/fake";
import { GraphError } from "../graph/errors";
import { pathSegment } from "../graph/client";
import { tokenErrorCode } from "../oauth";
import { addConnection, createMemoryStore } from "../testing/memory-store";
import { createMemoryMinutesStore } from "../testing/memory-minutes-store";
import { cleanEmailBody, isForwardSubject, messageBodyToText } from "./body";
import { PdfBudget, extractPdfText } from "./pdf";
import { emptyPiiMap, maskPii, unmaskDeep, unmaskPii } from "./pii";
import {
  MIN_SOURCE_CHARS,
  chooseMinutesMessage,
  isValidMessageId,
  runMinutesRound,
  searchMinutesNow,
  type MinutesDeps,
} from "./run";
import type { MinutesCheckpoint } from "./store";

/** Correções da M2 (achados de "Fase M2 — testes" + decisão de desmascarar). */

const NOW = new Date("2026-11-26T15:00:00.000Z");
const M2 = ["openid", "Calendars.Read", "Mail.Read"];

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function msg(id: string, o: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    internetMessageId: `<${id}@mail>`,
    subject: "Ata: 1:1 Ana",
    receivedDateTime: "2026-11-24T15:00:00Z",
    from: { emailAddress: { address: "gestor@jump.com.br" } },
    toRecipients: [{ emailAddress: { address: "ana@jump.com.br" } }],
    categories: [],
    body: {
      contentType: "text",
      content: "",
      uniqueContentType: "text",
      uniqueContent: "Combinamos manter a alocação; falar com joao@cliente.com.br sobre o plano.",
    },
    ...o,
  };
}

function setup(ai: string | null = null) {
  const { store, state } = createMemoryStore();
  state.users.set("u-mgr", {
    user: { id: "u-mgr", name: "G", email: "gestor@jump.com.br", roles: ["PROJECT_MANAGER"] },
    consultantId: null,
  });
  addConnection(state, { id: "c-mgr", userId: "u-mgr", mailbox: "gestor@jump.com.br", scopes: M2 });
  const { minutes, state: mstate } = createMemoryMinutesStore();
  mstate.connectionsByUser.set("u-mgr", "c-mgr");
  mstate.consultantEmails.set("cons-ana", ["ana@jump.com.br"]);
  const cp: MinutesCheckpoint = {
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
  };
  mstate.checkpoints.set("chk1", cp);
  const graph: FakeGraph = createFakeGraphClient();
  const response =
    ai ??
    JSON.stringify({
      summary: "Falar com [EMAIL_1] sobre o plano.",
      decisions: [],
      attentionPoints: [],
      actions: [{ title: "Enviar plano a [EMAIL_1]", owner: "[EMAIL_1]", dueDate: null, quote: "falar com [EMAIL_1]" }],
    });
  const aiProvider = {
    complete: vi.fn<(p: string, o?: unknown) => Promise<string | null>>(async () => response),
    completeWithDocument: vi.fn(async () => null),
  } satisfies AiTextProvider;
  const runExtraction = vi.fn(async () => "done");
  const deps: MinutesDeps = {
    store,
    minutes,
    graphFor: () => graph,
    ai: aiProvider,
    runExtraction,
    owner: "t",
    now: () => NOW,
  };
  return { deps, graph, mstate, aiProvider, runExtraction };
}

describe("4. ata e cards desmascarados; fonte e IA mascaradas", () => {
  it("notas e cards de Ação têm o dado real; transcrição e prompt só marcadores", async () => {
    const s = setup();
    s.graph.addMessage(msg("m1"));
    await runMinutesRound(s.deps);
    const cp = s.mstate.checkpoints.get("chk1")!;
    expect(cp.notes).toContain("Falar com joao@cliente.com.br");
    expect(cp.notes).not.toContain("[EMAIL_1]");
    expect(cp.transcription).toContain("[EMAIL_1]");
    expect(cp.transcription).not.toContain("joao@cliente.com.br");
    expect(s.mstate.actionItems[0]).toMatchObject({
      title: "Enviar plano a joao@cliente.com.br",
      ownerText: "joao@cliente.com.br",
      sourceQuote: "falar com joao@cliente.com.br",
    });
    const [prompt] = s.aiProvider.complete.mock.calls[0];
    expect(prompt).not.toContain("joao@cliente.com.br");
  });

  it("mapa: marcador desconhecido fica como está; prefixos separam execuções", () => {
    const a = maskPii("x ana@a.com", emptyPiiMap());
    const b = maskPii("y bia@b.com", emptyPiiMap("X"));
    expect(a.masked).toBe("x [EMAIL_1]");
    expect(b.masked).toBe("y [EMAIL_X1]");
    expect(unmaskPii("[EMAIL_1] e [EMAIL_X1] e [EMAIL_9]", b.map)).toBe("[EMAIL_1] e bia@b.com e [EMAIL_9]");
    expect(unmaskDeep({ l: ["[EMAIL_1]"], n: 1, d: null }, a.map)).toEqual({ l: ["ana@a.com"], n: 1, d: null });
  });
});

describe("5. corte depois da máscara", () => {
  it("dado pessoal que cruzaria o corte já está mascarado inteiro", () => {
    const { masked } = maskPii(`${"a ".repeat(10)}joao.pereira@cliente.com.br${" b".repeat(10)}`);
    expect(masked).toContain("[EMAIL_1]");
  });
});

describe("6. CPF com espaços/pontos sem falsos positivos", () => {
  it("mascara as variantes", () => {
    for (const cpf of ["123.456.789-09", "123 456 789 09", "123.456.789.09", "12345678909", "123456789-09"]) {
      expect(maskPii(`CPF ${cpf} ok`).masked).toBe("CPF [CPF_1] ok");
    }
  });
  it("não mascara números longos, protocolos, datas e valores", () => {
    for (const text of [
      "pedido 1234567890123456 ok",
      "protocolo 123456789012 ok",
      "valor R$ 1.234.567,89 em 05/12/2026",
      "versão 1.2.3.4",
    ]) {
      expect(maskPii(text).masked).toBe(text);
    }
  });
});

describe("3. ata encaminhada e texto curto", () => {
  const forwarded =
    "Segue a ata.\n\n________________________________\nDe: Ana\nEnviado: segunda-feira\nPara: Gestor\nAssunto: 1:1 Ana\n\nDecisões: manter alocação; Ana enviará o plano até 05/12.\n\nDe: Outro\nEnviado: antes\nHISTORICO-MAIS-ANTIGO";

  it("assunto ENC:/FW:/Fwd: preserva o bloco encaminhado sem os cabeçalhos", () => {
    expect(isForwardSubject("ENC: 1:1 Ana")).toBe(true);
    expect(isForwardSubject("RE: Fwd: x")).toBe(true);
    expect(isForwardSubject("RE: 1:1 Ana")).toBe(false);
    const text = messageBodyToText(
      { contentType: "text", content: forwarded, uniqueContentType: "text", uniqueContent: "Segue a ata." },
      { subject: "ENC: 1:1 Ana" },
    );
    expect(text).toContain("Segue a ata.");
    expect(text).toContain("Decisões: manter alocação");
    expect(text).not.toMatch(/^De: Ana/m);
    expect(text).not.toMatch(/Enviado:/);
    expect(text).not.toContain("HISTORICO-MAIS-ANTIGO");
  });

  it("sem keepQuoted, resposta comum continua sem o histórico", () => {
    expect(cleanEmailBody(forwarded)).toBe("Segue a ata.");
    expect(cleanEmailBody(forwarded, { keepQuoted: true })).toContain("manter alocação");
  });

  it("texto próprio curto (RE:) usa o bloco citado; ata sai dele", async () => {
    const s = setup();
    s.graph.addMessage(
      msg("m1", {
        subject: "RE: 1:1 Ana",
        body: { contentType: "text", content: forwarded, uniqueContentType: "text", uniqueContent: "Segue a ata." },
      }),
    );
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
    expect(s.mstate.checkpoints.get("chk1")!.transcription).toContain("manter alocação");
  });

  it("fonte curta demais: não grava RECORDED, fica FAILED recuperável e volta à fila", async () => {
    const s = setup();
    s.graph.addMessage(
      msg("m1", { body: { contentType: "text", content: "", uniqueContentType: "text", uniqueContent: "Segue a ata." } }),
    );
    expect("Seguea ata.".length).toBeLessThan(MIN_SOURCE_CHARS);
    await runMinutesRound(s.deps);
    expect(s.mstate.checkpoints.get("chk1")!.checkpointStatus).toBe("DRAFT");
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "FAILED", lastError: "source_too_short" });
    expect(s.aiProvider.complete).not.toHaveBeenCalled();
    // 9. FAILED não é terminal: o job volta a procurar e acha a ata que chegou depois.
    s.graph.addMessage(msg("m2", { categories: ["JumpFlow"], receivedDateTime: "2026-11-25T10:00:00Z" }));
    const second = await runMinutesRound(s.deps);
    expect(second.saved).toBe(1);
    expect(s.mstate.minutes.get("chk1")).toMatchObject({ status: "DONE", internetMessageId: "<m2@mail>" });
  });
});

describe("7. anexo com erro não derruba a ata", () => {
  it("listagem de anexos 404: segue só com o corpo", async () => {
    const s = setup();
    s.graph.addMessage(
      msg("m1", {
        attachments: [{ id: "a1", name: "a.pdf", contentType: "application/pdf", size: 10, isInline: false, bytes: new Uint8Array() }],
      }),
    );
    s.graph.listAttachments = async () => {
      throw new GraphError("not_found", "404", { status: 404 });
    };
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: true, value: "saved" });
  });

  it("reauth no anexo continua derrubando a rodada (erro da conexão)", async () => {
    const s = setup();
    s.graph.addMessage(
      msg("m1", {
        attachments: [{ id: "a1", name: "a.pdf", contentType: "application/pdf", size: 10, isInline: false, bytes: new Uint8Array() }],
      }),
    );
    s.graph.getAttachment = async () => {
      throw new GraphError("reauth", "401", { status: 401 });
    };
    expect(await searchMinutesNow("chk1", "u-mgr", s.deps)).toEqual({ ok: false, code: "reauth" });
  });
});

describe("8. id de mensagem", () => {
  it("allowlist de caracteres; '.' e '..' nunca viram segmento de ponto", async () => {
    for (const ok of ["AAMkAGI2THVSAAA=", "a-b_c+d/e="]) expect(isValidMessageId(ok)).toBe(true);
    for (const bad of ["..", ".", "x?$select=body", "x#f", "%2e%2e", "a b", "", "---"]) expect(isValidMessageId(bad)).toBe(false);
    expect(pathSegment("..")).toBe("%252E%252E");
    expect(pathSegment("a/b")).toBe("a%2Fb");
    const s = setup();
    expect(await chooseMinutesMessage("chk1", "..", "u-mgr", s.deps)).toEqual({ ok: true, value: "not_candidate" });
    expect(s.graph.calls.mail).toHaveLength(0);
  });
});

describe("2. formato real do Entra para consentimento retirado", () => {
  it("invalid_grant + suberror/AADSTS65001/error_codes → consent_required; invalid_grant puro não", () => {
    expect(tokenErrorCode({ error: "invalid_grant", suberror: "consent_required" }, 400)).toBe("consent_required");
    expect(tokenErrorCode({ error: "invalid_grant", error_codes: [65001] }, 400)).toBe("consent_required");
    expect(
      tokenErrorCode({ error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented" }, 400),
    ).toBe("consent_required");
    expect(tokenErrorCode({ error: "invalid_grant", error_description: "AADSTS70008: expired" }, 400)).toBe("invalid_grant");
    expect(tokenErrorCode({}, 503)).toBe("http_503");
  });
});

describe("1. PDF: orçamento de tempo e entradas hostis lineares", () => {
  function pdf(body: string): Uint8Array {
    return new Uint8Array(Buffer.from(`%PDF-1.5\n${body}`, "latin1"));
  }

  it("orçamento de tempo estourado aborta a extração (unsupported/time_budget)", () => {
    let calls = 0;
    // 1ª leitura do relógio = início; as seguintes já passaram do prazo de 2 s.
    const budget = new PdfBudget(2_000, () => (calls++ === 0 ? 0 : 10_000));
    const content = deflateSync(Buffer.from("BT (texto suficiente para ser lido como ata ok) Tj ET", "latin1"));
    const doc = Buffer.concat([
      Buffer.from("%PDF-1.5\n1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n", "latin1"),
      Buffer.from(`2 0 obj << /Filter /FlateDecode /Length ${content.length} >>\nstream\n`, "latin1"),
      content,
      Buffer.from("\nendstream endobj\n", "latin1"),
    ]);
    expect(extractPdfText(new Uint8Array(doc), budget)).toEqual({ kind: "unsupported", reason: "time_budget" });
  });

  it.each([
    ["muitos 'obj' sem cabeçalho", "obj ".repeat(300_000)],
    ["dígitos e espaços antes de obj", `${"1 ".repeat(300_000)}obj`],
    ["dicionários abertos aninhados", `1 0 obj ${"<< /A ".repeat(200_000)}`],
    ["referências gigantes", `1 0 obj [${"9999999999 0 R ".repeat(100_000)}] endobj`],
    ["strings/hex sem fechamento", `1 0 obj << /A (${"(".repeat(300_000)} /B <${"a".repeat(500_000)}`],
  ])("%s termina em < 1 s", (_label, body) => {
    const { value, ms } = timed(() => extractPdfText(pdf(body)));
    expect(value.kind).not.toBe("text");
    expect(ms).toBeLessThan(1000);
  });

  it("content stream hostil ('<<' sem fim, arrays profundos, '(' sem fim) termina em < 1 s", () => {
    const content = `${"<< ".repeat(100_000)}${"[".repeat(100_000)}${"(".repeat(100_000)}`;
    const doc = `1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n2 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream endobj`;
    const { ms } = timed(() => extractPdfText(pdf(doc)));
    expect(ms).toBeLessThan(1000);
  });
});
