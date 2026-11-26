import type { GraphMessageBody } from "../graph/types";
import { testShortLine, tidyText, truncateAtSpace } from "./text-safe";

/**
 * Corpo do e-mail de ata → texto (M365 M2). PURO, sem dependência.
 *
 * - Prefere `uniqueBody` (só a parte nova, sem o histórico citado) e o corpo em
 *   texto (o Graph converte com `Prefer: outlook.body-content-type="text"`).
 *   HTML que ainda chegue é convertido por {@link htmlToText} em tempo linear.
 * - {@link cleanEmailBody} corta citações (resposta anterior), assinatura e
 *   rodapés de celular/aviso legal, deixando só a mensagem nova.
 * - O resultado vive só em memória: o que é guardado é o texto-fonte MASCARADO.
 */

export const MAX_BODY_TEXT_CHARS = 200_000;
/** Teto do texto de entrada ANTES de qualquer regex (defesa em profundidade). */
export const MAX_BODY_INPUT_CHARS = 300_000;

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  agrave: "à", acirc: "â", ecirc: "ê", ocirc: "ô", atilde: "ã", otilde: "õ", ccedil: "ç",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  Agrave: "À", Acirc: "Â", Ecirc: "Ê", Ocirc: "Ô", Atilde: "Ã", Otilde: "Õ", Ccedil: "Ç",
};

function validCodePoint(n: number): boolean {
  if (!Number.isInteger(n) || n <= 0 || n > 0x10ffff) return false;
  if (n < 0x20 && n !== 0x09 && n !== 0x0a && n !== 0x0d) return false;
  if (n >= 0x7f && n <= 0x9f) return false;
  if (n >= 0xd800 && n <= 0xdfff) return false;
  return true;
}

export function decodeEntities(s: string): string {
  // Quantificadores limitados: sem backtracking quadrático em "&" + letras/dígitos longos.
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|[a-z]{1,32}\d{0,4});/gi, (m, e: string) => {
    if (Object.prototype.hasOwnProperty.call(ENTITIES, e)) return ENTITIES[e];
    const k = e.toLowerCase();
    if (k.startsWith("#x")) {
      const n = parseInt(k.slice(2), 16);
      return validCodePoint(n) ? String.fromCodePoint(n) : m;
    }
    if (k.startsWith("#")) {
      const n = parseInt(k.slice(1), 10);
      return validCodePoint(n) ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

/** Remove blocos `<tag ...>...</tag>` em tempo linear (sem regex preguiçosa). */
function stripBlock(s: string, tag: string): string {
  const lower = s.toLowerCase();
  let out = "";
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(`<${tag}`, pos);
    if (start < 0) break;
    out += s.slice(pos, start);
    const end = lower.indexOf(`</${tag}`, start);
    if (end < 0) return out;
    const gt = s.indexOf(">", end);
    pos = gt < 0 ? s.length : gt + 1;
  }
  return out + s.slice(pos);
}

const BLOCK_TAGS = new Set(["p", "div", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "br", "hr", "blockquote"]);

/**
 * HTML → texto em uma passada linear: tags de bloco viram quebra de linha,
 * `<blockquote>` (citação) é descartado, o resto das tags some.
 */
export function htmlToText(html: string, opts: { keepQuotes?: boolean } = {}): string {
  let s = String(html ?? "").slice(0, MAX_BODY_TEXT_CHARS * 2);
  const drop = opts.keepQuotes ? ["head", "style", "script"] : ["head", "style", "script", "blockquote"];
  for (const tag of drop) s = stripBlock(s, tag);
  let out = "";
  let pos = 0;
  for (;;) {
    const lt = s.indexOf("<", pos);
    if (lt < 0) break;
    out += s.slice(pos, lt);
    const gt = s.indexOf(">", lt);
    if (gt < 0) {
      out += s.slice(lt);
      pos = s.length;
      break;
    }
    const name = /^<\/?\s*([a-zA-Z0-9]+)/.exec(s.slice(lt, Math.min(gt + 1, lt + 40)))?.[1]?.toLowerCase();
    if (name && BLOCK_TAGS.has(name)) out += "\n";
    pos = gt + 1;
  }
  out += s.slice(pos);
  return decodeEntities(out);
}

/** Linhas que abrem o histórico citado (o resto da mensagem é descartado). */
const QUOTE_HEADER_RES: RegExp[] = [
  /^-{2,}\s*(?:original message|mensagem original|forwarded message|mensagem encaminhada)\s*-{2,}/i,
  /^_{10,}\s*$/,
  /^(?:em|on|el)\s.{3,200}(?:escreveu|wrote|escribió)\s*:\s*$/i,
  /^(?:de|from)\s*:\s*.+$/i,
];
/** Linha que inicia a assinatura / rodapé (corta daqui para baixo). */
const SIGNATURE_RES: RegExp[] = [
  /^--\s*$/,
  /^(?:enviado|sent)\s+(?:do|de|from)\s+(?:meu|my)\s+/i,
  /^(?:obter|get)\s+(?:o\s+)?outlook\s+(?:para|for)\s+/i,
  /^(?:aviso legal|confidentiality notice|disclaimer)\b/i,
];

/** Cabeçalho de mensagem citada/encaminhada (De:/Enviado:/Para:/Assunto:…). */
const HEADER_FIELD_RE = /^(?:de|from|enviado|enviada|sent|data|date|para|to|cc|cco|bcc|assunto|subject|enviado em)\s*:/i;

/** "De: X" só abre citação se as próximas linhas forem campos de cabeçalho. */
function opensHeader(lines: string[], i: number): boolean {
  const next = lines.slice(i + 1, i + 4).map((l) => l.trim()).find(Boolean) ?? "";
  return testShortLine(/^(?:enviado|enviada|sent|data|date|para|to)\s*:/i, next);
}

function isQuoteStart(lines: string[], i: number): boolean {
  const trimmed = lines[i].trim();
  if (testShortLine(/^(?:de|from)\s*:/i, trimmed)) return opensHeader(lines, i);
  return QUOTE_HEADER_RES.slice(0, 3).some((re) => testShortLine(re, trimmed));
}

function tidyLines(lines: string[]): string {
  return tidyText(lines.join("\n"));
}

/** Assunto de encaminhamento (ENC:/FW:/Fwd:/TR:/RV:/WG:). */
export function isForwardSubject(subject: string | null | undefined): boolean {
  return testShortLine(/^\s*(?:(?:re|res|aw|sv)\s*:\s*)*(?:enc|fw|fwd|tr|rv|wg)\s*:/i, String(subject ?? "").slice(0, 300));
}

/**
 * Tira citações (linhas `>`, cabeçalho "De:/Enviado:", "Em ... escreveu:"),
 * assinatura e rodapés. Mantém só a mensagem nova. PURA.
 *
 * `keepQuoted`: a ata pode estar no conteúdo ENCAMINHADO/citado (assunto
 * ENC:/FW: ou texto próprio curto). Nesse caso o PRIMEIRO bloco citado é
 * preservado, sem as linhas de cabeçalho (De:/Enviado:/Para:/Assunto:) e sem
 * o prefixo `>`, até o próximo cabeçalho de citação.
 */
export function cleanEmailBody(text: string, opts: { keepQuoted?: boolean } = {}): string {
  const lines = truncateAtSpace(String(text ?? ""), MAX_BODY_INPUT_CHARS)
    .replace(/\r\n?/g, "\n")
    .replace(/\u0000/g, "")
    .split("\n");
  const own: string[] = [];
  let i = 0;
  let quoteAt = -1;
  for (; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith(">")) {
      if (quoteAt < 0) quoteAt = i;
      continue;
    }
    if (isQuoteStart(lines, i)) {
      quoteAt = i;
      break;
    }
    if (SIGNATURE_RES.some((re) => testShortLine(re, trimmed))) break;
    own.push(lines[i]);
  }
  const ownText = tidyLines(own);
  if (!opts.keepQuoted) return ownText.slice(0, MAX_BODY_TEXT_CHARS);

  // Assinatura antes do bloco citado: procura o início da citação depois dela.
  if (quoteAt < 0) {
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k].trim().startsWith(">") || isQuoteStart(lines, k)) {
        quoteAt = k;
        break;
      }
    }
  }
  if (quoteAt < 0) return ownText.slice(0, MAX_BODY_TEXT_CHARS);

  const quoted: string[] = [];
  const unquote = (l: string) => l.replace(/^[ \t]*(?:>[ \t]?)+/, "");
  const stripped = lines.map(unquote);
  let k = quoteAt;
  // Cabeçalho do bloco: separadores, "Em … escreveu:", campos De/Enviado/Para/Assunto.
  for (; k < lines.length; k += 1) {
    const t = stripped[k].trim();
    if (!t || testShortLine(HEADER_FIELD_RE, t) || QUOTE_HEADER_RES.slice(0, 3).some((re) => testShortLine(re, t))) continue;
    break;
  }
  for (; k < lines.length; k += 1) {
    if (k > quoteAt && isQuoteStart(stripped, k)) break;
    quoted.push(stripped[k]);
    if (quoted.length > 20_000) break;
  }
  const quotedText = tidyLines(quoted);
  if (!quotedText) return ownText.slice(0, MAX_BODY_TEXT_CHARS);
  return [ownText, quotedText ? `Conteúdo encaminhado:\n${quotedText}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, MAX_BODY_TEXT_CHARS);
}

function toText(content: string, type: "text" | "html", keepQuotes: boolean): string {
  return type === "html" ? htmlToText(content, { keepQuotes }) : content;
}

/**
 * Corpo do Graph → texto limpo. Prefere `uniqueBody` (só a parte nova). Em
 * encaminhamento (assunto ENC:/FW:) ou com `keepQuoted` (quem chama decide:
 * o texto próprio + anexos não bastam para ser ata), usa também o corpo
 * completo e preserva o bloco encaminhado/citado — o `uniqueBody` de um
 * encaminhamento costuma NÃO trazer o conteúdo encaminhado.
 */
export function messageBodyToText(
  body: GraphMessageBody,
  opts: { subject?: string | null; keepQuoted?: boolean } = {},
): string {
  const useUnique = body.uniqueContent !== null && body.uniqueContent.trim() !== "";
  const primary = useUnique ? body.uniqueContent! : body.content;
  const primaryType = useUnique ? body.uniqueContentType ?? "text" : body.contentType;
  const own = cleanEmailBody(toText(primary, primaryType, false));
  if (!opts.keepQuoted && !isForwardSubject(opts.subject)) return own;
  const candidates = [
    { content: body.content, type: body.contentType },
    ...(useUnique ? [{ content: body.uniqueContent!, type: (body.uniqueContentType ?? "text") as "text" | "html" }] : []),
  ].map((c) => cleanEmailBody(toText(c.content, c.type, true), { keepQuoted: true }));
  return candidates.reduce((a, b) => (b.length > a.length ? b : a), own);
}
