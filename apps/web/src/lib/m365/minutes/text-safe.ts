/**
 * Utilitários de texto LINEARES para conteúdo não confiável (corpo/assunto de
 * e-mail, anexos, saída da IA). Nada aqui usa regex com quantificador que
 * possa reescanear a entrada: tudo é varredura manual ou `split` + operação
 * por linha. PURO.
 */

/** Espaço/tab no fim de cada linha removido; 3+ linhas vazias viram 1; trim. */
export function tidyText(text: string): string {
  const out: string[] = [];
  let blank = 0;
  for (const raw of String(text ?? "").split("\n")) {
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0d) break;
      end -= 1;
    }
    const line = end === raw.length ? raw : raw.slice(0, end);
    if (line === "") {
      blank += 1;
      if (blank > 1) continue;
    } else {
      blank = 0;
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Remove cercas ```json … ``` do início/fim (saída da IA), sem regex. */
export function stripCodeFence(raw: string): string {
  let s = String(raw ?? "").trim();
  if (s.startsWith("```")) {
    const nl = s.indexOf("\n");
    const head = (nl < 0 ? s : s.slice(0, nl)).slice(3).trim().toLowerCase();
    s = head === "" || head === "json" ? (nl < 0 ? "" : s.slice(nl + 1)) : s.slice(3);
  }
  s = s.trim();
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

function isSpaceCode(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d || c === 0x0c || c === 0x0b || c === 0xa0;
}

/**
 * Caracteres que podem compor um telefone/CPF/CNPJ (dígitos e separadores).
 * Um bloco assim no fim do corte é descartado: um dado partido ao meio pelo
 * espaço interno ("123 456 789 09", "(11) 98765-4321") nunca vai cru à IA.
 */
function isNumericDataCode(c: number): boolean {
  return (
    (c >= 0x30 && c <= 0x39) ||
    isSpaceCode(c) ||
    c === 0x2e || // .
    c === 0x2d || // -
    c === 0x28 || // (
    c === 0x29 || // )
    c === 0x2b || // +
    c === 0x2f // /
  );
}

/**
 * Corta em `max` caracteres SEM partir um dado pessoal ao meio. Teto de defesa
 * aplicado ANTES de qualquer regex/máscara. LINEAR (cada posição é visitada no
 * máximo uma vez por laço).
 *
 * 1. Recua até um espaço (sem limite de distância): o bloco sem espaço que
 *    cruza o teto (e-mail, palavra, CPF sem espaço…) é descartado inteiro —
 *    nunca vira fragmento. Texto sem nenhum espaço antes do teto → "".
 * 2. Descarta também a cauda de dígitos/separadores que sobrar (um telefone ou
 *    CPF com espaços internos cortado no meio).
 */
export function truncateAtSpace(text: string, max: number): string {
  if (text.length <= max) return text;
  return safeHeadCut(text, Math.max(0, max));
}

/** `text.slice(0, cut)` recuado para uma fronteira segura (ver truncateAtSpace). */
function safeHeadCut(text: string, at: number): string {
  let cut = at;
  // Corte exatamente antes de um espaço já está numa fronteira.
  if (cut >= text.length || !isSpaceCode(text.charCodeAt(cut))) {
    while (cut > 0 && !isSpaceCode(text.charCodeAt(cut - 1))) cut -= 1;
  }
  // Cauda numérica (dígitos + separadores, inclusive espaços) que pode ser o
  // começo de um telefone/CPF/CNPJ partido.
  let tail = cut;
  let hasDigit = false;
  while (tail > 0 && isNumericDataCode(text.charCodeAt(tail - 1))) {
    const c = text.charCodeAt(tail - 1);
    if (c >= 0x30 && c <= 0x39) hasDigit = true;
    tail -= 1;
  }
  if (hasDigit) cut = tail;
  return text.slice(0, cut).trimEnd();
}

/**
 * O texto pode ter sido cortado logo DEPOIS dele (fim desconhecido): descarta
 * o último bloco sem espaço e a cauda numérica — mesma regra do
 * {@link truncateAtSpace}, aplicada ao fim do texto. LINEAR.
 */
export function dropPartialTail(text: string): string {
  return safeHeadCut(text, text.length);
}

/**
 * Os últimos `max` caracteres SEM começar no meio de um dado: avança até depois
 * de um espaço e pula a cabeça de dígitos/separadores que sobrar (o fim de um
 * telefone/CPF partido). LINEAR.
 */
export function safeTailSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - Math.max(0, max);
  if (start > 0 && !isSpaceCode(text.charCodeAt(start - 1))) {
    while (start < text.length && !isSpaceCode(text.charCodeAt(start))) start += 1;
  }
  let head = start;
  let hasDigit = false;
  while (head < text.length && isNumericDataCode(text.charCodeAt(head))) {
    const c = text.charCodeAt(head);
    if (c >= 0x30 && c <= 0x39) hasDigit = true;
    head += 1;
  }
  if (hasDigit) start = head;
  return text.slice(start).trimStart();
}

/** Linhas maiores que isso não são testadas como cabeçalho/assinatura. */
export const MAX_HEADER_LINE = 500;

/** `re.test(line)` só para linhas curtas (cabeçalhos nunca são enormes). */
export function testShortLine(re: RegExp, line: string): boolean {
  return line.length <= MAX_HEADER_LINE && re.test(line);
}
