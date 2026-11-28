import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { GraphAttachmentMeta } from "../graph/types";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  extractAttachmentText,
  isSupportedAttachment,
  pickAttachments,
} from "./attachments";
import { extractDocxText } from "./docx";
import { extractPdfText, parseToUnicode } from "./pdf";

/**
 * QA M2 — entradas hostis nos leitores próprios de anexo (PDF/DOCX).
 * Nada aqui pode travar o processo, lançar exceção ou inflar sem limite.
 * Os `it.fails` documentam achados (ver "Fase M2 — testes" no ANDAMENTO).
 */

function buildPdf(objects: Array<{ dict: string; stream?: Buffer }>): Uint8Array {
  const parts: Buffer[] = [Buffer.from("%PDF-1.5\n", "latin1")];
  objects.forEach((o, i) => {
    const num = i + 1;
    if (o.stream) {
      parts.push(Buffer.from(`${num} 0 obj\n<< ${o.dict} /Length ${o.stream.length} >>\nstream\n`, "latin1"));
      parts.push(o.stream);
      parts.push(Buffer.from("\nendstream\nendobj\n", "latin1"));
    } else {
      parts.push(Buffer.from(`${num} 0 obj\n${o.dict}\nendobj\n`, "latin1"));
    }
  });
  parts.push(Buffer.from("trailer << /Root 1 0 R >>\n%%EOF", "latin1"));
  return new Uint8Array(Buffer.concat(parts));
}

function raw(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "latin1"));
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

const TEXT_PAGE = "BT /F1 12 Tf 72 700 Td (Ata da reuniao: manter alocacao e revisar metas) Tj ET";

describe("PDF hostil — termina, não lança, não infla sem limite", () => {
  it("lixo, truncado, sem endstream/endobj e parênteses desbalanceados viram unsupported (nunca lança)", () => {
    const inputs = [
      raw("%PDF-1.7\n"),
      raw("%PDF-1.7\n1 0 obj << /Type /Page /Contents 2 0 R >>\n2 0 obj << /Length 999999 >>\nstream\nBT (abc"),
      raw("%PDF-1.7\n1 0 obj << /Type /Page /Contents 2 0 R"),
      raw(`%PDF-1.7\n1 0 obj << /Type /Page /Contents 2 0 R >> endobj\n2 0 obj << /Length 20 >>\nstream\nBT ((((((((( Tj ET\nendstream endobj`),
      new Uint8Array(0),
      raw("%PDF-"),
    ];
    for (const input of inputs) {
      const result = extractPdfText(input);
      expect(result.kind).not.toBe("text");
    }
  });

  it("stream FlateDecode corrompido não derruba (página com texto válido continua lida)", () => {
    const pdf = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dict: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>" },
      { dict: "<< /Type /Page /Parent 2 0 R /Contents 5 0 R >>" },
      { dict: "<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>" },
      { dict: "/Filter /FlateDecode", stream: Buffer.from("isto nao e zlib") },
      { dict: "/Filter /FlateDecode", stream: deflateSync(Buffer.from(TEXT_PAGE, "latin1")) },
    ]);
    expect(extractPdfText(pdf)).toEqual({ kind: "text", text: "Ata da reuniao: manter alocacao e revisar metas" });
  });

  it("ciclos na árvore de páginas (Kids → pai) e em Parent terminam", () => {
    const pdf = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      // 2 é raiz; 3 é Pages filho que aponta de volta para 2 e para si mesmo.
      { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { dict: "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R 3 0 R 4 0 R] /Count 1 >>" },
      // Página sem Resources próprios cujo Parent forma ciclo 4 → 5 → 4.
      { dict: "<< /Type /Page /Parent 5 0 R /Contents 6 0 R >>" },
      { dict: "<< /Type /Pages /Parent 4 0 R /Kids [4 0 R] >>" },
      { dict: "/Filter /FlateDecode", stream: deflateSync(Buffer.from(TEXT_PAGE, "latin1")) },
    ]);
    const { value, ms } = timed(() => extractPdfText(pdf));
    expect(value.kind).toBe("text");
    expect(ms).toBeLessThan(1000);
  });

  it("object stream que se referencia e ID sem EI não entram em laço", () => {
    const objStm = deflateSync(Buffer.from("1 0 2 20 << /Type /ObjStm >>        << /Type /Page >>", "latin1"));
    const pdf = buildPdf([
      { dict: "/Type /ObjStm /N 2 /First 8 /Filter /FlateDecode", stream: objStm },
      { dict: "<< /Type /Page /Contents 3 0 R >>" },
      { dict: "", stream: Buffer.from("BT (texto antes da imagem inline com bastante coisa) Tj ET BI /W 1 /H 1 ID \x00\x01\x02 sem fim", "latin1") },
    ]);
    const { value, ms } = timed(() => extractPdfText(pdf));
    expect(["text", "unsupported"]).toContain(value.kind);
    expect(ms).toBeLessThan(1000);
  });

  it("PDF cifrado (/Encrypt Standard) → unsupported, sem tentar ler", () => {
    const pdf = buildPdf([
      { dict: "<< /Filter /Standard /V 2 /R 3 /O (xxxxxxxx) /U (yyyyyyyy) /P -4 >>" },
      { dict: "<< /Type /Page /Contents 3 0 R >>" },
      { dict: "", stream: Buffer.from(TEXT_PAGE, "latin1") },
    ]);
    expect(extractPdfText(pdf)).toEqual({ kind: "unsupported", reason: "encrypted" });
  });

  it("zip bomb num único stream: inflate cortado no teto por stream, sem estourar memória", () => {
    // ~100 KB comprimidos → 100 MB descomprimidos (acima do teto de 40 MB por stream).
    const bomb = deflateSync(Buffer.alloc(100 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(MAX_ATTACHMENT_BYTES);
    const pdf = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { dict: "<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>" },
      { dict: "/Filter /FlateDecode", stream: bomb },
    ]);
    const { value, ms } = timed(() => extractPdfText(pdf));
    expect(value.kind).toBe("unsupported");
    expect(ms).toBeLessThan(3000);
  });

  // ACHADO (bloqueante): não há teto AGREGADO de descompressão nem cache por
  // objeto — o mesmo stream de ~39 MB referenciado por N páginas é inflado N
  // vezes (até 5000 páginas). Medido: 20 páginas ≈ 9,4 s de CPU síncrona.
  it("teto AGREGADO de descompressão por PDF (mesmo stream referenciado por várias páginas)", () => {
    const bomb = deflateSync(Buffer.alloc(39 * 1024 * 1024, 0x41));
    const pdfWith = (pages: number) => {
      const kids = Array.from({ length: pages }, (_, i) => `${i + 4} 0 R`).join(" ");
      const objs: Array<{ dict: string; stream?: Buffer }> = [
        { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
        { dict: `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>` },
        { dict: "/Filter /FlateDecode", stream: bomb },
      ];
      for (let i = 0; i < pages; i += 1) objs.push({ dict: "<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>" });
      return buildPdf(objs);
    };
    const one = timed(() => extractPdfText(pdfWith(1))).ms;
    const many = timed(() => extractPdfText(pdfWith(6))).ms;
    // Esperado: com teto agregado (ou cache por objeto), 6 páginas custam ~o mesmo que 1.
    expect(many).toBeLessThan(Math.max(one * 2, 500));
  });

  // ACHADO (bloqueante): CMap ToUnicode com muitos `bfrange` de 65 536 códigos
  // não tem teto global — ~40 bytes por faixa custam ~2,6 ms; 1 MB de CMap
  // trava o event loop por minutos (e é reprocessado por página).
  it("CMap ToUnicode com milhares de bfrange largos termina rápido", () => {
    const ranges = "<0000> <FFFF> <0000>\n".repeat(1000);
    const { ms } = timed(() =>
      parseToUnicode(`1 begincodespacerange <0000> <FFFF> endcodespacerange\n1000 beginbfrange\n${ranges}endbfrange`),
    );
    expect(ms).toBeLessThan(1000);
  });

  // ACHADO (bloqueante): `/(\d+)\s+(\d+)\s+obj\b/g` (e `refsIn`) é quadrático
  // numa sequência longa de dígitos: 40 k dígitos ≈ 0,6 s; 10 MB ≈ horas.
  it("sequência longa de dígitos (ReDoS no cabeçalho de objeto) termina rápido", () => {
    const { value, ms } = timed(() => extractPdfText(raw(`%PDF-1.5\n${"1".repeat(100_000)}\n`)));
    expect(value.kind).toBe("unsupported");
    expect(ms).toBeLessThan(1000);
  });
});

describe("DOCX hostil", () => {
  it("zip bomb com tamanho declarado honesto é recusado antes de inflar", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:t>a</w:t>${" ".repeat(40 * 1024 * 1024)}`);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(bytes.byteLength).toBeLessThan(MAX_ATTACHMENT_BYTES);
    await expect(extractDocxText(bytes)).rejects.toThrow("docx_too_large");
    expect(await extractAttachmentText({ name: "ata.docx", contentType: null }, bytes)).toEqual({
      kind: "skipped",
      reason: "error",
    });
  });

  it("zip bomb com tamanho declarado FORJADO (pequeno) é abortado pelo jszip sem inflar tudo", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:t>a</w:t>${" ".repeat(60 * 1024 * 1024)}`);
    const buf = Buffer.from(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    for (let i = 0; i < buf.length - 4; i += 1) {
      const sig = buf.readUInt32LE(i);
      if (sig === 0x04034b50) buf.writeUInt32LE(100, i + 22);
      if (sig === 0x02014b50) buf.writeUInt32LE(100, i + 24);
    }
    const start = performance.now();
    const result = await extractAttachmentText({ name: "ata.docx", contentType: null }, new Uint8Array(buf));
    expect(result).toEqual({ kind: "skipped", reason: "error" });
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("docx sem document.xml, zip corrompido e XML com entidades estranhas não lançam", async () => {
    const empty = new JSZip();
    empty.file("outro.xml", "<x/>");
    const noDoc = await empty.generateAsync({ type: "uint8array" });
    expect(await extractAttachmentText({ name: "a.docx", contentType: null }, noDoc)).toEqual({ kind: "skipped", reason: "error" });
    expect(await extractAttachmentText({ name: "a.docx", contentType: null }, raw("PK\x03\x04lixo"))).toEqual({
      kind: "skipped",
      reason: "error",
    });
    const weird = new JSZip();
    weird.file("word/document.xml", "<w:p><w:t>&#0; &#xD800; &#99999999; &bogus; ok &amp; fim</w:t></w:p>");
    const text = await extractDocxText(await weird.generateAsync({ type: "uint8array" }));
    expect(text).toContain("ok & fim");
    expect(text).not.toContain("\u0000");
  });
});

describe("limites de anexos", () => {
  const meta = (o: Partial<GraphAttachmentMeta> = {}): GraphAttachmentMeta => ({
    id: "a",
    name: "ata.pdf",
    contentType: "application/pdf",
    size: 1000,
    isInline: false,
    kind: "file",
    ...o,
  });

  it("exatamente 10 MB entra; 10 MB + 1 byte, tamanho 0, inline, item e referência não", () => {
    expect(isSupportedAttachment(meta({ size: MAX_ATTACHMENT_BYTES }))).toBe(true);
    expect(isSupportedAttachment(meta({ size: MAX_ATTACHMENT_BYTES + 1 }))).toBe(false);
    expect(isSupportedAttachment(meta({ size: 0 }))).toBe(false);
    expect(isSupportedAttachment(meta({ isInline: true }))).toBe(false);
    expect(isSupportedAttachment(meta({ kind: "item" }))).toBe(false);
    expect(isSupportedAttachment(meta({ kind: "reference" }))).toBe(false);
  });

  it("tipos não suportados (doc, xlsx, png, zip, exe disfarçado) são ignorados", () => {
    for (const [name, contentType] of [
      ["ata.doc", "application/msword"],
      ["ata.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["foto.png", "image/png"],
      ["pacote.zip", "application/zip"],
      ["ata.pdf.exe", "application/octet-stream"],
      ["ata.txt", "text/plain"],
    ] as const) {
      expect(isSupportedAttachment(meta({ name, contentType }))).toBe(false);
    }
  });

  it(`no máximo ${MAX_ATTACHMENTS} anexos elegíveis, na ordem original`, () => {
    const metas = Array.from({ length: 8 }, (_, i) => meta({ id: `a${i}`, name: `p${i}.pdf` }));
    expect(pickAttachments(metas).map((m) => m.id)).toEqual(["a0", "a1", "a2"]);
  });

  it("bytes acima de 10 MB são recusados mesmo para tipo desconhecido; tipo desconhecido vira unsupported", async () => {
    expect(await extractAttachmentText({ name: "a.pdf", contentType: null }, new Uint8Array(MAX_ATTACHMENT_BYTES + 1))).toEqual({
      kind: "skipped",
      reason: "too_large",
    });
    expect(await extractAttachmentText({ name: "a.bin", contentType: "application/octet-stream" }, raw("x"))).toEqual({
      kind: "skipped",
      reason: "unsupported",
    });
  });
});
