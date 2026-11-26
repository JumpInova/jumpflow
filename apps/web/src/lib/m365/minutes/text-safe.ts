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

/**
 * Corta em `max` caracteres, recuando até um espaço (no máximo 200 posições)
 * para não partir uma palavra — e, portanto, nenhum dado pessoal — ao meio.
 * Teto de defesa aplicado ANTES de qualquer regex/máscara.
 */
export function truncateAtSpace(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  for (let k = max; k > max - 200 && k > 0; k -= 1) {
    const c = text.charCodeAt(k);
    if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) {
      cut = k;
      break;
    }
  }
  return text.slice(0, cut);
}

/** Linhas maiores que isso não são testadas como cabeçalho/assinatura. */
export const MAX_HEADER_LINE = 500;

/** `re.test(line)` só para linhas curtas (cabeçalhos nunca são enormes). */
export function testShortLine(re: RegExp, line: string): boolean {
  return line.length <= MAX_HEADER_LINE && re.test(line);
}
