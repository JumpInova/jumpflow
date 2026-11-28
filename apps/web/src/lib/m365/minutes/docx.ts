import JSZip from "jszip";
import { tidyText } from "./text-safe";

/**
 * Texto de um .docx (M365 M2). Usa o `jszip` que o projeto já tem (nenhuma
 * dependência nova): lê `word/document.xml` e junta os `<w:t>` por parágrafo.
 * Só em memória; nada do arquivo é guardado.
 */

/** Teto do XML descompactado (defesa contra zip bomb). */
export const DOCX_MAX_XML_BYTES = 30 * 1024 * 1024;
export const DOCX_MAX_TEXT_CHARS = 200_000;

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k in XML_ENTITIES) return XML_ENTITIES[k];
    const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isInteger(n) && n > 0x1f && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff)
      ? String.fromCodePoint(n)
      : m;
  });
}

/** Orçamento de tempo de parede por DOCX (mesmo princípio do PDF). */
export const DOCX_TIME_BUDGET_MS = 2_000;

/**
 * XML do corpo do Word → texto (parágrafos, tabs e quebras). PURA e LINEAR:
 * varredura com `indexOf` (sem regex sobre o XML) + orçamento de tempo.
 */
export function docxXmlToText(xml: string, now: () => number = Date.now): string {
  const deadline = now() + DOCX_TIME_BUDGET_MS;
  const out: string[] = [];
  let size = 0;
  let pos = 0;
  let steps = 0;
  const push = (piece: string) => {
    out.push(piece);
    size += piece.length;
  };
  while (size <= DOCX_MAX_TEXT_CHARS) {
    if ((++steps & 1023) === 0 && now() > deadline) throw new Error("docx_time_budget");
    const lt = xml.indexOf("<", pos);
    if (lt < 0) break;
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) break;
    // Nome da tag: até espaço, "/" ou ">" (no máximo 16 caracteres).
    let k = xml.charCodeAt(lt + 1) === 0x2f ? lt + 2 : lt + 1; // "</w:p>"
    const limit = Math.min(gt, lt + 17);
    while (k < limit) {
      const c = xml.charCodeAt(k);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2f || c === 0x3e) break;
      k += 1;
    }
    const name = xml.slice(lt + 1, k);
    const selfClosing = xml.charCodeAt(gt - 1) === 0x2f;
    if (name === "w:t" && !selfClosing) {
      const close = xml.indexOf("<", gt + 1);
      if (close < 0) break;
      if (xml.startsWith("</w:t>", close)) push(decodeXml(xml.slice(gt + 1, close)));
      pos = close;
      continue;
    }
    if (name === "w:tab" && selfClosing) push("\t");
    else if ((name === "w:br" || name === "w:cr") && selfClosing) push("\n");
    else if (name === "/w:p") push("\n");
    pos = gt + 1;
  }
  return tidyText(out.join("")).slice(0, DOCX_MAX_TEXT_CHARS);
}

/** Bytes de um .docx → texto. Lança em arquivo inválido. */
export async function extractDocxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("docx_without_document");
  // jszip expõe o tamanho descompactado declarado; recusa antes de inflar.
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (typeof declared === "number" && declared > DOCX_MAX_XML_BYTES) throw new Error("docx_too_large");
  const xml = await entry.async("string");
  if (xml.length > DOCX_MAX_XML_BYTES) throw new Error("docx_too_large");
  return docxXmlToText(xml);
}
