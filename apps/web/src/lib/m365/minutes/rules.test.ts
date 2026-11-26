import { describe, expect, it } from "vitest";
import type { GraphMessage } from "../graph/types";
import { cleanEmailBody, htmlToText, messageBodyToText } from "./body";
import {
  composeSourceText,
  formatMinutesNotes,
  limitText,
  mapActionItems,
  parseIsoDate,
  parseMinutes,
  TRUNCATION_MARKER,
} from "./generate";
import { containsPii, maskPii } from "./pii";
import {
  normalizeSubject,
  selectMinutesCandidate,
  subjectMatches,
  toCandidate,
  type MinutesCandidate,
  type SelectionContext,
} from "./select";

const START = new Date("2026-11-24T13:00:00Z");
const NOW = new Date("2026-11-26T15:00:00Z");

function gm(id: string, o: Partial<GraphMessage> = {}): GraphMessage {
  return {
    id,
    internetMessageId: `<${id}@x>`,
    subject: "1:1 Ana",
    receivedDateTime: "2026-11-24T15:00:00Z",
    from: { emailAddress: { address: "gestor@jump.com.br", name: "Gestor" } },
    toRecipients: [{ emailAddress: { address: "ana@jump.com.br" } }],
    ccRecipients: [],
    categories: [],
    ...o,
  };
}

function ctx(o: Partial<SelectionContext> = {}): SelectionContext {
  return {
    eventSubject: "1:1 Ana",
    eventStartAt: START,
    managerEmails: ["gestor@jump.com.br"],
    consultantEmails: ["ana@jump.com.br"],
    usedInternetMessageIds: new Set(),
    now: NOW,
    ...o,
  };
}

const cands = (...msgs: GraphMessage[]) => msgs.map(toCandidate).filter((c): c is MinutesCandidate => c !== null);

describe("assunto normalizado", () => {
  it("tira RE:/RES:/ENC:/FW: encadeados, acento, pontuação e caixa", () => {
    expect(normalizeSubject("RE: ENC: Fw: Res:  1:1 — Ána ")).toBe("1 1 ana");
    expect(normalizeSubject("TR: Checkpoint semanal!")).toBe("checkpoint semanal");
  });
  it("contém o assunto do evento por palavras inteiras", () => {
    expect(subjectMatches("Ata - RE: 1:1 Ana (notas)", "1:1 Ana")).toBe(true);
    expect(subjectMatches("1:1 Anabela", "1:1 Ana")).toBe(false);
    expect(subjectMatches("qualquer", "  ")).toBe(false);
    expect(subjectMatches("ab", "ab")).toBe(false); // assunto curto demais não casa
  });
});

describe("toCandidate", () => {
  it("descarta convites/respostas de reunião, rascunhos e sem internetMessageId", () => {
    expect(toCandidate(gm("a", { "@odata.type": "#microsoft.graph.eventMessageRequest" }))).toBeNull();
    expect(toCandidate(gm("b", { subject: "Aceito: 1:1 Ana" }))).toBeNull();
    expect(toCandidate(gm("c", { subject: "Accepted: 1:1 Ana" }))).toBeNull();
    expect(toCandidate(gm("d", { isDraft: true }))).toBeNull();
    expect(toCandidate(gm("e", { internetMessageId: null }))).toBeNull();
    expect(toCandidate(gm("f", { receivedDateTime: "lixo" }))).toBeNull();
  });
  it("webLink só de host da Microsoft", () => {
    expect(toCandidate(gm("a", { webLink: "https://evil.com/x" }))!.webLink).toBeNull();
    expect(toCandidate(gm("b", { webLink: "https://outlook.office365.com/owa/x" }))!.webLink).not.toBeNull();
  });
});

describe("selectMinutesCandidate", () => {
  it("assunto + consultor em to → selecionada", () => {
    const r = selectMinutesCandidate(cands(gm("m1")), ctx());
    expect(r).toMatchObject({ kind: "selected", candidate: { messageId: "m1" } });
  });

  it("assunto + só o gestor (sem consultor) também vale", () => {
    const r = selectMinutesCandidate(cands(gm("m1", { toRecipients: [{ emailAddress: { address: "rh@jump.com.br" } }] })), ctx());
    expect(r.kind).toBe("selected");
  });

  it("assunto sem consultor nem gestor em from/to/cc → nada", () => {
    const r = selectMinutesCandidate(
      cands(gm("m1", { from: { emailAddress: { address: "x@y.com" } }, toRecipients: [] })),
      ctx(),
    );
    expect(r.kind).toBe("none");
  });

  it("categoria JumpFlow sozinha NÃO basta (evita a ata de outro consultor)", () => {
    const other = gm("m1", { subject: "Notas", categories: ["JumpFlow"], toRecipients: [{ emailAddress: { address: "bruno@jump.com.br" } }] });
    expect(selectMinutesCandidate(cands(other), ctx()).kind).toBe("none");
    const mine = gm("m2", { subject: "Notas", categories: ["jumpflow"] });
    expect(selectMinutesCandidate(cands(mine), ctx())).toMatchObject({ kind: "selected", candidate: { messageId: "m2" } });
  });

  it("categoria vence assunto (maior pontuação)", () => {
    const r = selectMinutesCandidate(
      cands(gm("m1"), gm("m2", { categories: ["JumpFlow"], receivedDateTime: "2026-11-24T14:00:00Z" })),
      ctx(),
    );
    expect(r).toMatchObject({ kind: "selected", candidate: { messageId: "m2" } });
  });

  it("empate na maior pontuação → ambíguo (nada escolhido sozinho)", () => {
    const r = selectMinutesCandidate(cands(gm("m1"), gm("m2", { receivedDateTime: "2026-11-25T10:00:00Z" })), ctx());
    expect(r.kind).toBe("ambiguous");
  });

  it("mesma mensagem em Enviados e Entrada (mesmo internetMessageId) não empata", () => {
    const r = selectMinutesCandidate(cands(gm("m1"), gm("m1-copy", { internetMessageId: "<m1@x>" })), ctx());
    expect(r.kind).toBe("selected");
  });

  it("janela: antes do início do evento ou assunto depois de +7 dias não entram", () => {
    const before = gm("m1", { receivedDateTime: "2026-11-24T12:59:00Z" });
    expect(selectMinutesCandidate(cands(before), ctx()).kind).toBe("none");
    const late = gm("m2", { receivedDateTime: "2026-12-01T13:01:00Z" });
    expect(selectMinutesCandidate(cands(late), ctx({ now: new Date("2026-12-02T00:00:00Z") })).kind).toBe("none");
    const lateCategory = gm("m3", { receivedDateTime: "2026-12-01T13:01:00Z", categories: ["JumpFlow"] });
    expect(selectMinutesCandidate(cands(lateCategory), ctx({ now: new Date("2026-12-02T00:00:00Z") })).kind).toBe("selected");
  });

  it("internetMessageId já usado por outro checkpoint é descartado", () => {
    const r = selectMinutesCandidate(cands(gm("m1")), ctx({ usedInternetMessageIds: new Set(["<m1@x>"]) }));
    expect(r.kind).toBe("none");
  });
});

describe("mascaramento de PII", () => {
  it("e-mail, telefone, CPF e CNPJ viram marcadores consistentes", () => {
    const { masked } = maskPii(
      "Fale com ana@cliente.com ou ANA@cliente.com; tel +55 (11) 98765-4321 e 11 3456-7890; CPF 123.456.789-09 / 12345678909; CNPJ 12.345.678/0001-90 e 12345678000190.",
    );
    expect(masked).toBe(
      "Fale com [EMAIL_1] ou [EMAIL_1]; tel [TELEFONE_1] e [TELEFONE_2]; CPF [CPF_1] / [CPF_1]; CNPJ [CNPJ_1] e [CNPJ_1].",
    );
    expect(containsPii(masked)).toBe(false);
  });
  it("não mascara datas, horas, valores e códigos curtos", () => {
    const text = "Reunião em 05/12/2026 às 14:30, orçamento R$ 12.500,00, ticket 12345678.";
    expect(maskPii(text).masked).toBe(text);
  });
});

describe("corpo do e-mail → texto", () => {
  it("corta histórico citado (De:/Enviado:, 'Em ... escreveu:', linhas >) e assinatura", () => {
    const text = [
      "Segue a ata.",
      "Decidimos X.",
      "> citação antiga",
      "--",
      "Gestor | Jump",
    ].join("\n");
    expect(cleanEmailBody(text)).toBe("Segue a ata.\nDecidimos X.");
    expect(cleanEmailBody("Oi\nEm seg., 24 de nov. de 2026 às 10:00, Ana escreveu:\nantigo")).toBe("Oi");
    expect(cleanEmailBody("Oi\n\nDe: Ana\nEnviado: segunda\nPara: Gestor\nantigo")).toBe("Oi");
    expect(cleanEmailBody("De: hoje combinamos\nX")).toBe("De: hoje combinamos\nX");
    expect(cleanEmailBody("Ata\nEnviado do meu iPhone")).toBe("Ata");
  });
  it("HTML vira texto sem blockquote/style e com entidades decodificadas", () => {
    const html = "<html><head><style>p{}</style></head><body><p>Ol&aacute;&nbsp;time</p><div>A&amp;B</div><blockquote>velho</blockquote></body></html>";
    expect(htmlToText(html).replace(/\s+/g, " ").trim()).toBe("Olá time A&B");
  });
  it("prefere uniqueBody (só a parte nova)", () => {
    expect(
      messageBodyToText({ contentType: "text", content: "novo\nvelho", uniqueContentType: "html", uniqueContent: "<p>novo</p>" }),
    ).toBe("novo");
    expect(messageBodyToText({ contentType: "text", content: "só corpo", uniqueContentType: null, uniqueContent: null })).toBe("só corpo");
  });
});

describe("geração da ata", () => {
  it("parse valida o JSON da IA com Zod (cercas toleradas; schema inválido recusado)", () => {
    const ok = parseMinutes('```json\n{"summary":"S","decisions":["D"],"attentionPoints":[],"actions":[{"title":"T","owner":null,"dueDate":"2026-12-05"}]}\n```');
    expect(ok.ok).toBe(true);
    expect(parseMinutes(null)).toEqual({ ok: false, reason: "empty_response" });
    expect(parseMinutes("não é json")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseMinutes('{"decisions":[]}')).toEqual({ ok: false, reason: "schema_mismatch" });
    expect(parseMinutes('{"summary":"S","actions":[{"title":""}]}')).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  it("formata notas com seções e origem; ações viram cards com data só quando inequívoca", () => {
    const parsed = parseMinutes(
      '{"summary":"Resumo X","decisions":["D1"],"attentionPoints":["A1"],"actions":[{"title":"T1","owner":"Ana","dueDate":"2026-12-05","quote":"q"},{"title":"T2","dueDate":"2026-02-30"}]}',
    );
    if (!parsed.ok) throw new Error("parse");
    const notes = formatMinutesNotes(parsed.data, {
      receivedAt: new Date("2026-11-24T15:00:00Z"),
      attachmentsUsed: 1,
      attachmentsSkipped: 1,
      truncated: false,
    });
    expect(notes).toContain("Resumo\nResumo X");
    expect(notes).toContain("Decisões\n- D1");
    expect(notes).toContain("Pontos de atenção\n- A1");
    expect(notes).toContain("- T1 — responsável: Ana — prazo: 2026-12-05");
    expect(notes).toContain("1 anexo(s) lido(s), 1 anexo(s) não suportado(s)");
    const items = mapActionItems(parsed.data);
    expect(items[0].dueDate?.toISOString()).toBe("2026-12-05T00:00:00.000Z");
    expect(items[1]).toMatchObject({ dueDate: null, dueText: "2026-02-30", ownerText: null });
    expect(parseIsoDate("05/12/2026")).toBeNull();
  });

  it("corta textos longos 70% início / 30% fim com marcador", () => {
    const text = "a".repeat(700) + "b".repeat(300) + "c".repeat(1000);
    const { text: out, truncated } = limitText(text, 500);
    expect(truncated).toBe(true);
    expect(out.length).toBe(500);
    expect(out).toContain(TRUNCATION_MARKER);
    expect(out.startsWith("a")).toBe(true);
    expect(out.endsWith("c")).toBe(true);
    expect(limitText("curto", 500)).toEqual({ text: "curto", truncated: false });
  });

  it("texto-fonte junta corpo e anexos com rótulo", () => {
    expect(composeSourceText({ bodyText: "corpo", attachments: [{ name: "ata.docx", text: "anexo" }] })).toBe(
      "Corpo do e-mail:\ncorpo\n\nAnexo (ata.docx):\nanexo",
    );
    expect(composeSourceText({ bodyText: "  ", attachments: [] })).toBe("");
  });
});
