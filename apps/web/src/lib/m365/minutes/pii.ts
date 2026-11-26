/**
 * Mascaramento de dados pessoais ANTES de qualquer chamada à IA (M365 M2/M3).
 * PURO.
 *
 * E-mails, CNPJ, CPF e telefones brasileiros viram marcadores `[EMAIL_1]`,
 * `[CNPJ_1]`, `[CPF_1]`, `[TELEFONE_1]`. O mesmo valor recebe sempre o mesmo
 * marcador dentro de um mapa, então a IA consegue relacionar as ocorrências.
 *
 * A IA só vê texto mascarado. A saída dela (ata e cards) é DESMASCARADA em
 * memória com o mapa da mesma execução ({@link unmaskPii}/{@link unmaskDeep})
 * antes de gravar; o texto-fonte guardado (`transcription`) fica mascarado. O
 * mapa nunca é persistido nem logado.
 *
 * Ordem: e-mail → CNPJ → CPF → telefone (CNPJ antes de CPF porque 14 dígitos
 * contêm 11; documentos antes de telefone porque um CPF sem máscara também
 * parece telefone).
 */

export type PiiKind = "EMAIL" | "CNPJ" | "CPF" | "TELEFONE";

export interface PiiMap {
  /** `${kind}:${valor normalizado}` → marcador */
  byValue: Map<string, string>;
  /** marcador → valor original (só em memória; nunca persistido). */
  byToken: Map<string, string>;
  counters: Record<PiiKind, number>;
  /**
   * Prefixo do número no marcador (`[EMAIL_X1]`): separa mapas de execuções
   * diferentes quando o mesmo texto já tem marcadores de outra execução.
   */
  prefix: string;
}

export function emptyPiiMap(prefix = ""): PiiMap {
  return {
    byValue: new Map(),
    byToken: new Map(),
    counters: { EMAIL: 0, CNPJ: 0, CPF: 0, TELEFONE: 0 },
    prefix: prefix.replace(/[^A-Z]/g, "").slice(0, 3),
  };
}

// Quantificadores LIMITADOS + lookbehind (só começa no início de um bloco de
// caracteres de e-mail): linear mesmo com 200k letras ou "a@" + 200k letras.
const EMAIL_RE =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,7}\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
// 12.345.678/0001-90 ou 14 dígitos seguidos (sem estar colado em outros dígitos).
const CNPJ_RE = /(?<!\d)(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})(?!\d)/g;
// 123.456.789-09, 123 456 789 09, 123.456.789.09 ou 11 dígitos seguidos
// (separadores só espaço/ponto/hífen, nunca quebra de linha; sem dígito colado).
const CPF_RE = /(?<![\d.])(\d{3}[. ]?\d{3}[. ]?\d{3}[-. ]?\d{2})(?![\d])/g;
// +55 (11) 98765-4321 | (11) 3456-7890 | 11 987654321 | 11987654321 | 98765-4321
const PHONE_RE =
  /(?<![\d\w])(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?(?:9[\s.]?\d{4}|\d{4})[\s.-]?\d{4}(?![\d\w])/g;

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

function tokenFor(map: PiiMap, kind: PiiKind, norm: string, original: string): string {
  const key = `${kind}:${norm}`;
  const existing = map.byValue.get(key);
  if (existing) return existing;
  map.counters[kind] += 1;
  const token = `[${kind}_${map.prefix}${map.counters[kind]}]`;
  map.byValue.set(key, token);
  map.byToken.set(token, original);
  return token;
}

/** Telefone plausível: 8 a 13 dígitos, não um dígito repetido. */
function isPlausiblePhone(raw: string): boolean {
  const d = digits(raw);
  if (d.length < 8 || d.length > 13) return false;
  if (/^(\d)\1+$/.test(d)) return false;
  // 8 dígitos sem separador: mais provável código/quantidade.
  if (d.length === 8 && !/[\s.-]/.test(raw)) return false;
  return true;
}

/**
 * Mascara `text`. Passe o mesmo `map` para mascarar vários campos com
 * marcadores consistentes.
 */
export function maskPii(text: string, map: PiiMap = emptyPiiMap()): { masked: string; map: PiiMap } {
  let s = String(text ?? "");
  s = s.replace(EMAIL_RE, (m) => tokenFor(map, "EMAIL", m.toLowerCase(), m));
  s = s.replace(CNPJ_RE, (m) => (digits(m).length === 14 ? tokenFor(map, "CNPJ", digits(m), m) : m));
  s = s.replace(CPF_RE, (m) => (digits(m).length === 11 ? tokenFor(map, "CPF", digits(m), m) : m));
  s = s.replace(PHONE_RE, (m) => (isPlausiblePhone(m) ? tokenFor(map, "TELEFONE", digits(m), m.trim()) : m));
  return { masked: s, map };
}

const TOKEN_RE = /\[(?:EMAIL|CNPJ|CPF|TELEFONE)_[A-Z]{0,3}\d{1,6}\]/g;

/** Restaura os marcadores DESTE mapa; marcador desconhecido fica como está. */
export function unmaskPii(text: string, map: PiiMap): string {
  return String(text ?? "").replace(TOKEN_RE, (m) => map.byToken.get(m) ?? m);
}

/** Restaura recursivamente as strings de um objeto/array (saída da IA). */
export function unmaskDeep<T>(value: T, map: PiiMap): T {
  if (typeof value === "string") return unmaskPii(value, map) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => unmaskDeep(v, map)) as unknown as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = unmaskDeep(v, map);
    return out as T;
  }
  return value;
}

/** Há algum dado pessoal reconhecível no texto? */
export function containsPii(text: string): boolean {
  const { map } = maskPii(text);
  return map.byValue.size > 0;
}

export const PII_NOTE =
  "Dados pessoais foram trocados por marcadores como [EMAIL_1], [TELEFONE_1], [CPF_1], [CNPJ_1]: mantenha os marcadores como estão se precisar citá-los e nunca tente adivinhar o valor.";
