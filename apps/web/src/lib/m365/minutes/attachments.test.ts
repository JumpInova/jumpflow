import { deflateSync } from "node:zlib";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENT_BYTES,
  attachmentFormat,
  extractAttachmentText,
  isSupportedAttachment,
  pickAttachments,
} from "./attachments";
import { docxXmlToText, extractDocxText } from "./docx";
import { extractPdfText, parseToUnicode } from "./pdf";

/** Monta um PDF mínimo a partir de objetos (dicionário + stream opcional). */
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

describe("formatos e limites", () => {
  it("só PDF/DOCX de arquivo, não inline, até 10 MB", () => {
    const base = { id: "a", isInline: false, kind: "file" as const, size: 100 };
    expect(attachmentFormat({ name: "Ata.PDF", contentType: null })).toBe("pdf");
    expect(attachmentFormat({ name: "x", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })).toBe("docx");
    expect(attachmentFormat({ name: "ata.doc", contentType: "application/msword" })).toBeNull();
    expect(isSupportedAttachment({ ...base, name: "a.pdf", contentType: "application/pdf" })).toBe(true);
    expect(isSupportedAttachment({ ...base, name: "a.pdf", contentType: "application/pdf", size: MAX_ATTACHMENT_BYTES + 1 })).toBe(false);
    expect(isSupportedAttachment({ ...base, name: "a.pdf", contentType: "application/pdf", isInline: true })).toBe(false);
    expect(isSupportedAttachment({ ...base, name: "a.pdf", contentType: "application/pdf", kind: "item" })).toBe(false);
    const many = Array.from({ length: 5 }, (_, i) => ({ ...base, id: `a${i}`, name: `${i}.pdf`, contentType: "application/pdf" }));
    expect(pickAttachments(many)).toHaveLength(3);
  });

  it("bytes acima de 10 MB são recusados mesmo com metadado mentiroso", async () => {
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    expect(await extractAttachmentText({ name: "a.pdf", contentType: "application/pdf" }, big)).toEqual({
      kind: "skipped",
      reason: "too_large",
    });
  });
});

describe("DOCX (jszip já instalado)", () => {
  it("extrai parágrafos, tabs e quebras de document.xml", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document><w:body><w:p><w:r><w:t>Ata do 1:1</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Decisão: </w:t></w:r><w:r><w:t>manter &amp; seguir</w:t></w:r><w:r><w:tab/><w:t>ok</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });
    expect(await extractDocxText(bytes)).toBe("Ata do 1:1\nDecisão: manter & seguir\tok");
    const result = await extractAttachmentText({ name: "ata.docx", contentType: null }, bytes);
    expect(result).toMatchObject({ kind: "text", name: "ata.docx" });
  });

  it("arquivo inválido vira skipped (nunca lança)", async () => {
    expect(await extractAttachmentText({ name: "ata.docx", contentType: null }, new Uint8Array([1, 2, 3]))).toEqual({
      kind: "skipped",
      reason: "error",
    });
    expect(docxXmlToText("<w:p></w:p>")).toBe("");
  });
});

describe("PDF (sem dependência nova)", () => {
  it("texto com fonte simples em stream FlateDecode", () => {
    const content = deflateSync(Buffer.from("BT /F1 12 Tf 72 700 Td (Ata da reuni\\343o) Tj 0 -14 Td [(Decis) -50 (\\365es: manter)] TJ ET", "latin1"));
    const pdf = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { dict: "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>" },
      { dict: "/Filter /FlateDecode", stream: content },
      { dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
    ]);
    expect(extractPdfText(pdf)).toEqual({ kind: "text", text: "Ata da reunião\nDecisões: manter" });
  });

  it("fonte Type0/Identity-H com ToUnicode (padrão do Word)", () => {
    const cmap = Buffer.from(
      "begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0001> <0041> <0002> <00E7> endbfchar\n1 beginbfrange <0003> <0005> <0061> endbfrange\nendcmap",
      "latin1",
    );
    const word = "0001000300040005"; // "Aabc"
    const content = deflateSync(Buffer.from(`BT /F2 11 Tf <${word.repeat(6)}> Tj T* <0002> Tj ET`, "latin1"));
    const pdf = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F2 5 0 R >> >> >>" },
      // Resources herdados do pai.
      { dict: "<< /Type /Page /Parent 2 0 R /Contents [4 0 R] >>" },
      { dict: "/Filter /FlateDecode", stream: content },
      { dict: "<< /Type /Font /Subtype /Type0 /Encoding /Identity-H /ToUnicode 6 0 R >>" },
      { dict: "/Filter /FlateDecode", stream: deflateSync(cmap) },
    ]);
    const result = extractPdfText(pdf);
    expect(result).toEqual({ kind: "text", text: `${"Aabc".repeat(6)}\nç` });
  });

  it("CMap bfrange com array e incremento", () => {
    const decoder = parseToUnicode(
      "1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfrange <41> <43> [<0058> <0059> <005A>] endbfrange",
    );
    expect(decoder.bytesPerCode).toBe(1);
    expect([...decoder.map!.values()].join("")).toBe("XYZ");
  });

  it("PDF escaneado (só imagem) → scanned; lixo → unsupported", () => {
    const scanned = buildPdf([
      { dict: "<< /Type /Catalog /Pages 2 0 R >>" },
      { dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
      { dict: "<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>" },
      { dict: "", stream: Buffer.from("q 600 0 0 800 0 0 cm /Im1 Do Q", "latin1") },
      { dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode", stream: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    expect(extractPdfText(scanned)).toEqual({ kind: "scanned" });
    expect(extractPdfText(new Uint8Array(Buffer.from("not a pdf")))).toEqual({ kind: "unsupported", reason: "not_pdf" });
  });

  it("PDF escaneado vira skipped/scanned no anexo", async () => {
    const scanned = buildPdf([
      { dict: "<< /Type /Page /Contents 2 0 R >>" },
      { dict: "", stream: Buffer.from("q /Im1 Do Q", "latin1") },
      { dict: "/Subtype /Image", stream: Buffer.from([0]) },
    ]);
    expect(await extractAttachmentText({ name: "scan.pdf", contentType: "application/pdf" }, scanned)).toEqual({
      kind: "skipped",
      reason: "scanned",
    });
  });
});
