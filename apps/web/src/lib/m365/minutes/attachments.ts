import type { GraphAttachmentMeta } from "../graph/types";
import { extractDocxText } from "./docx";
import { extractPdfText } from "./pdf";

/**
 * Anexos da ata por e-mail (M365 M2): só PDF e DOCX de até 10 MB, de arquivo
 * (não inline, não item/referência). O texto é extraído em memória; os bytes
 * nunca são guardados. PDF escaneado não é suportado (sem OCR).
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Teto de anexos processados por mensagem. */
export const MAX_ATTACHMENTS = 3;

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf"]);
const DOCX_TYPES = new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

export type AttachmentFormat = "pdf" | "docx";

export function attachmentFormat(meta: Pick<GraphAttachmentMeta, "name" | "contentType">): AttachmentFormat | null {
  const type = (meta.contentType ?? "").toLowerCase().split(";")[0].trim();
  const name = meta.name.toLowerCase();
  if (PDF_TYPES.has(type) || name.endsWith(".pdf")) return "pdf";
  if (DOCX_TYPES.has(type) || name.endsWith(".docx")) return "docx";
  return null;
}

/** Anexo elegível para leitura (antes de baixar). */
export function isSupportedAttachment(meta: GraphAttachmentMeta): boolean {
  return (
    meta.kind === "file" &&
    !meta.isInline &&
    meta.size > 0 &&
    meta.size <= MAX_ATTACHMENT_BYTES &&
    attachmentFormat(meta) !== null
  );
}

/** Seleciona até {@link MAX_ATTACHMENTS} anexos elegíveis (ordem original). */
export function pickAttachments(metas: GraphAttachmentMeta[]): GraphAttachmentMeta[] {
  return metas.filter(isSupportedAttachment).slice(0, MAX_ATTACHMENTS);
}

export type AttachmentText =
  | { kind: "text"; name: string; text: string }
  | { kind: "skipped"; reason: "scanned" | "unsupported" | "too_large" | "error" };

/** Bytes → texto. Nunca lança. */
export async function extractAttachmentText(
  meta: Pick<GraphAttachmentMeta, "name" | "contentType">,
  bytes: Uint8Array,
): Promise<AttachmentText> {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return { kind: "skipped", reason: "too_large" };
  const format = attachmentFormat(meta);
  try {
    if (format === "pdf") {
      const result = extractPdfText(bytes);
      if (result.kind === "text") return { kind: "text", name: meta.name, text: result.text };
      return { kind: "skipped", reason: result.kind === "scanned" ? "scanned" : "unsupported" };
    }
    if (format === "docx") {
      const text = await extractDocxText(bytes);
      return text.trim() ? { kind: "text", name: meta.name, text } : { kind: "skipped", reason: "unsupported" };
    }
    return { kind: "skipped", reason: "unsupported" };
  } catch {
    return { kind: "skipped", reason: "error" };
  }
}
