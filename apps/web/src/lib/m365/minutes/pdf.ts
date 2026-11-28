import { inflateSync } from "node:zlib";

/**
 * Texto de um PDF (M365 M2) SEM dependência nova: `node:zlib` + um leitor
 * mínimo de objetos/streams. Cobre o caso comum de atas exportadas do
 * Word/Outlook/Google Docs (texto real, streams FlateDecode, fontes com
 * ToUnicode, object streams). Não é um leitor PDF completo:
 *
 * - PDF escaneado (só imagem) NÃO é suportado → `scanned` (sem OCR).
 * - PDF cifrado → `unsupported`.
 * - Filtros além de FlateDecode (LZW/ASCII85…) são ignorados.
 *
 * Defesa contra entrada hostil (o anexo vem de qualquer remetente):
 * - parsing LINEAR: varredura manual + tokenizador próprio; nenhuma regex com
 *   backtracking sobre a entrada;
 * - tetos GLOBAIS por documento: bytes inflados, objetos, páginas, entradas de
 *   CMap, bytes de content stream interpretados e texto extraído;
 * - cache por objeto: stream decodificado, decodificador de fonte e texto de
 *   content stream (o mesmo objeto referenciado por N páginas custa 1 vez);
 * - orçamento de tempo de parede ({@link PDF_TIME_BUDGET_MS}) checado entre
 *   operações: estourou, a extração deste anexo é abortada (`unsupported`).
 *
 * Tudo em memória; nada do arquivo é guardado.
 */

export type PdfTextResult =
  | { kind: "text"; text: string }
  | { kind: "scanned" }
  | { kind: "unsupported"; reason: string };

export const PDF_MAX_TEXT_CHARS = 200_000;
export const PDF_TIME_BUDGET_MS = 2_000;
const MAX_OBJECTS = 20_000;
const MAX_PAGES = 500;
/** Teto por stream e teto AGREGADO do documento (bytes inflados). */
const MAX_INFLATE_PER_STREAM = 40 * 1024 * 1024;
const MAX_INFLATE_TOTAL = 64 * 1024 * 1024;
/** Teto agregado de bytes de content stream interpretados. */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
/** Teto agregado de entradas de CMap (bfchar + códigos expandidos de bfrange). */
const MAX_CMAP_ENTRIES = 200_000;
const MAX_RANGE = 65_536;
const MAX_DEPTH = 32;
const MAX_ITEMS = 100_000;
/** Menos que isso (sem espaços) num PDF com imagem = escaneado. */
const MIN_TEXT_CHARS = 20;

class BudgetExceeded extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Orçamento de um documento (tempo + tetos agregados). */
export class PdfBudget {
  readonly deadline: number;
  inflated = 0;
  contentBytes = 0;
  cmapEntries = 0;
  private ticks = 0;
  constructor(
    timeMs: number = PDF_TIME_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + timeMs;
  }
  /** Checa o relógio a cada 1024 chamadas (barato). */
  tick(): void {
    this.ticks += 1;
    if ((this.ticks & 1023) === 0) this.check();
  }
  check(): void {
    if (this.now() > this.deadline) throw new BudgetExceeded("time_budget");
  }
}

// ── tokenizador / parser de objetos (linear) ─────────────────────────────────

type PdfVal =
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "ref"; n: number }
  | { t: "arr"; v: PdfVal[] }
  | { t: "dict"; v: Map<string, PdfVal> }
  | { t: "str" }
  | { t: "kw"; v: string };

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}
function isDelim(c: number): boolean {
  // ( ) < > [ ] { } / %
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25
  );
}
function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function skipWsAndComments(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isWs(c)) i += 1;
    else if (c === 0x25) {
      while (i < s.length && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i += 1;
    } else break;
  }
  return i;
}

/** Fim de uma string literal `( … )` balanceada (ou o fim do texto). */
function skipLiteral(s: string, i: number): number {
  let depth = 0;
  for (; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) i += 1;
    else if (c === 0x28) depth += 1;
    else if (c === 0x29) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return s.length;
}

function readWord(s: string, i: number): number {
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (isWs(c) || isDelim(c)) break;
    i += 1;
  }
  return i;
}

/** Inteiro sem sinal curto (até 10 dígitos) ou null. */
function shortInt(s: string, from: number, to: number): number | null {
  if (to <= from || to - from > 10) return null;
  for (let k = from; k < to; k += 1) if (!isDigit(s.charCodeAt(k))) return null;
  return Number(s.slice(from, to));
}

interface ParseState {
  s: string;
  budget: PdfBudget;
  items: number;
}

/**
 * Lê UM valor PDF a partir de `i`. Linear: o lookahead de referência `n g R`
 * só olha dois tokens à frente (cada um limitado a 10 dígitos).
 */
function parseValue(st: ParseState, i: number, depth: number): { val: PdfVal; next: number } | null {
  const s = st.s;
  st.budget.tick();
  if ((st.items += 1) > MAX_ITEMS || depth > MAX_DEPTH) return null;
  i = skipWsAndComments(s, i);
  if (i >= s.length) return null;
  const c = s.charCodeAt(i);
  if (c === 0x3c && s.charCodeAt(i + 1) === 0x3c) {
    const map = new Map<string, PdfVal>();
    let j = i + 2;
    for (;;) {
      j = skipWsAndComments(s, j);
      if (j >= s.length) return { val: { t: "dict", v: map }, next: j };
      if (s.charCodeAt(j) === 0x3e && s.charCodeAt(j + 1) === 0x3e) return { val: { t: "dict", v: map }, next: j + 2 };
      if (s.charCodeAt(j) !== 0x2f) {
        const skipped = parseValue(st, j, depth + 1);
        if (!skipped) return { val: { t: "dict", v: map }, next: s.length };
        j = skipped.next;
        continue;
      }
      const end = readWord(s, j + 1);
      const key = s.slice(j + 1, Math.min(end, j + 129));
      const value = parseValue(st, end, depth + 1);
      if (!value) return { val: { t: "dict", v: map }, next: s.length };
      if (!map.has(key)) map.set(key, value.val);
      j = value.next;
    }
  }
  if (c === 0x5b) {
    const arr: PdfVal[] = [];
    let j = i + 1;
    for (;;) {
      j = skipWsAndComments(s, j);
      if (j >= s.length) return { val: { t: "arr", v: arr }, next: j };
      if (s.charCodeAt(j) === 0x5d) return { val: { t: "arr", v: arr }, next: j + 1 };
      const value = parseValue(st, j, depth + 1);
      if (!value) return { val: { t: "arr", v: arr }, next: s.length };
      arr.push(value.val);
      j = value.next;
    }
  }
  if (c === 0x28) return { val: { t: "str" }, next: skipLiteral(s, i) };
  if (c === 0x3c) {
    const end = s.indexOf(">", i);
    return { val: { t: "str" }, next: end < 0 ? s.length : end + 1 };
  }
  if (c === 0x2f) {
    const end = readWord(s, i + 1);
    return { val: { t: "name", v: s.slice(i + 1, Math.min(end, i + 129)) }, next: end };
  }
  if (isDelim(c)) return { val: { t: "kw", v: s[i] }, next: i + 1 };
  const end = readWord(s, i);
  const n = shortInt(s, i, end);
  if (n !== null) {
    const j1 = skipWsAndComments(s, end);
    const e1 = readWord(s, j1);
    if (shortInt(s, j1, e1) !== null) {
      const j2 = skipWsAndComments(s, e1);
      const after = s.charCodeAt(j2 + 1);
      if (s.charCodeAt(j2) === 0x52 && (j2 + 1 >= s.length || isWs(after) || isDelim(after))) {
        return { val: { t: "ref", n }, next: j2 + 1 };
      }
    }
    return { val: { t: "num", v: n }, next: end };
  }
  const word = end - i <= 32 ? s.slice(i, end) : "";
  const num = word ? Number(word) : NaN;
  if (Number.isFinite(num)) return { val: { t: "num", v: num }, next: end };
  return { val: { t: "kw", v: word }, next: end === i ? i + 1 : end };
}

interface PdfObject {
  val: PdfVal | null;
  stream: Buffer | null;
}

function dictOf(v: PdfVal | null | undefined): Map<string, PdfVal> | null {
  return v && v.t === "dict" ? v.v : null;
}
function nameOf(v: PdfVal | undefined): string | null {
  return v && v.t === "name" ? v.v : null;
}

/**
 * Número do objeto de `N G obj` conferido para TRÁS a partir de "obj":
 * espaços (≤32) + até 10 dígitos + espaços (≤32) + até 10 dígitos. Nunca regex.
 */
function headerBefore(src: string, objIdx: number): number | null {
  let k = objIdx - 1;
  const back = (pred: (c: number) => boolean, max: number) => {
    let count = 0;
    while (k >= 0 && count <= max && pred(src.charCodeAt(k))) {
      k -= 1;
      count += 1;
    }
    return count;
  };
  const ws1 = back(isWs, 32);
  if (ws1 === 0 || ws1 > 32) return null;
  const gen = back(isDigit, 10);
  if (gen === 0 || gen > 10) return null;
  const ws2 = back(isWs, 32);
  if (ws2 === 0 || ws2 > 32) return null;
  const numEnd = k + 1;
  const digits = back(isDigit, 10);
  if (digits === 0 || digits > 10) return null;
  if (k >= 0 && !isWs(src.charCodeAt(k)) && !isDelim(src.charCodeAt(k))) return null;
  return Number(src.slice(k + 1, numEnd));
}

function parseObjects(buf: Buffer, budget: PdfBudget): Map<number, PdfObject> {
  const src = buf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  let pos = 0;
  while (objects.size < MAX_OBJECTS) {
    budget.tick();
    const at = src.indexOf("obj", pos);
    if (at < 0) break;
    const after = src.charCodeAt(at + 3);
    const num = Number.isNaN(after) || isWs(after) || isDelim(after) ? headerBefore(src, at) : null;
    if (num === null) {
      pos = at + 3;
      continue;
    }
    const parsed = parseValue({ s: src, budget, items: 0 }, at + 3, 0);
    if (!parsed) {
      pos = at + 3;
      continue;
    }
    let next = parsed.next;
    let stream: Buffer | null = null;
    const k = skipWsAndComments(src, next);
    if (parsed.val.t === "dict" && src.startsWith("stream", k)) {
      let dataStart = k + "stream".length;
      if (src.charCodeAt(dataStart) === 0x0d) dataStart += 1;
      if (src.charCodeAt(dataStart) === 0x0a) dataStart += 1;
      const lenVal = parsed.val.v.get("Length");
      const len = lenVal && lenVal.t === "num" && Number.isInteger(lenVal.v) && lenVal.v >= 0 ? lenVal.v : null;
      let dataEnd: number;
      if (len !== null && dataStart + len <= src.length && src.startsWith("endstream", skipWsAndComments(src, dataStart + len))) {
        dataEnd = dataStart + len;
      } else {
        const es = src.indexOf("endstream", dataStart);
        if (es < 0) break;
        dataEnd = es;
      }
      stream = buf.subarray(dataStart, dataEnd);
      next = dataEnd;
    }
    if (!objects.has(num)) objects.set(num, { val: parsed.val, stream });
    pos = Math.max(next, at + 3);
  }
  return objects;
}

interface FontDecoder {
  bytesPerCode: 1 | 2;
  map: Map<number, string> | null;
}

class Doc {
  private readonly decoded = new Map<number, Buffer | null>();
  private readonly fonts = new Map<number, FontDecoder>();
  private readonly contentText = new Map<number, string>();
  constructor(
    readonly objects: Map<number, PdfObject>,
    readonly budget: PdfBudget,
  ) {}

  resolve(v: PdfVal | undefined, hops = 0): PdfVal | undefined {
    if (v && v.t === "ref" && hops < 8) return this.resolve(this.objects.get(v.n)?.val ?? undefined, hops + 1);
    return v;
  }

  /** Stream decodificado com cache por objeto e teto agregado de inflate. */
  stream(num: number): Buffer | null {
    if (this.decoded.has(num)) return this.decoded.get(num)!;
    this.budget.check();
    const obj = this.objects.get(num);
    const out = obj ? this.decode(obj) : null;
    this.decoded.set(num, out);
    return out;
  }

  private decode(obj: PdfObject): Buffer | null {
    if (!obj.stream) return null;
    const filter = dictOf(obj.val)?.get("Filter");
    const filters = !filter ? [] : filter.t === "arr" ? filter.v.map(nameOf) : [nameOf(filter)];
    if (filters.length === 0) return obj.stream;
    if (filters.length !== 1 || filters[0] !== "FlateDecode") return null;
    const remaining = MAX_INFLATE_TOTAL - this.budget.inflated;
    if (remaining <= 0) throw new BudgetExceeded("inflate_budget");
    try {
      const out = inflateSync(obj.stream, { maxOutputLength: Math.min(MAX_INFLATE_PER_STREAM, remaining) });
      this.budget.inflated += out.length;
      return out;
    } catch {
      // Corrompido ou acima do teto: consome orçamento para não repetir o custo.
      this.budget.inflated += Math.min(Math.max(obj.stream.length * 4, 1), remaining);
      return null;
    }
  }

  font(num: number): FontDecoder {
    const cached = this.fonts.get(num);
    if (cached) return cached;
    const dict = dictOf(this.objects.get(num)?.val ?? null);
    const tu = dict?.get("ToUnicode");
    const cmap = tu && tu.t === "ref" ? this.stream(tu.n) : null;
    let decoder: FontDecoder;
    if (cmap) {
      decoder = parseToUnicode(cmap.toString("latin1"), this.budget);
    } else {
      const encoding = nameOf(dict?.get("Encoding")) ?? "";
      const twoByte = nameOf(dict?.get("Subtype")) === "Type0" || encoding === "Identity-H" || encoding === "Identity-V";
      decoder = { bytesPerCode: twoByte ? 2 : 1, map: null };
    }
    this.fonts.set(num, decoder);
    return decoder;
  }

  /** Texto de um content stream (cache por objeto + teto agregado de bytes). */
  content(num: number, fonts: Map<string, FontDecoder>): string {
    const cached = this.contentText.get(num);
    if (cached !== undefined) return cached;
    const data = this.stream(num);
    let text = "";
    if (data) {
      const room = MAX_CONTENT_BYTES - this.budget.contentBytes;
      if (room <= 0) throw new BudgetExceeded("content_budget");
      const slice = data.length > room ? data.subarray(0, room) : data;
      this.budget.contentBytes += slice.length;
      text = contentStreamText(slice.toString("latin1"), fonts, this.budget);
    }
    this.contentText.set(num, text);
    return text;
  }
}

// ── páginas ──────────────────────────────────────────────────────────────────

function orderedPages(doc: Doc): number[] {
  const out: number[] = [];
  let root: number | null = null;
  for (const [num, obj] of doc.objects) {
    const d = dictOf(obj.val);
    if (d && nameOf(d.get("Type")) === "Pages" && !d.has("Parent")) {
      root = num;
      break;
    }
  }
  const seen = new Set<number>();
  const stack: Array<{ num: number; depth: number }> = root !== null ? [{ num: root, depth: 0 }] : [];
  while (stack.length > 0 && out.length < MAX_PAGES) {
    doc.budget.tick();
    const { num, depth } = stack.pop()!;
    if (seen.has(num) || depth > 50) continue;
    seen.add(num);
    const d = dictOf(doc.objects.get(num)?.val ?? null);
    if (!d) continue;
    if (nameOf(d.get("Type")) === "Page") {
      out.push(num);
      continue;
    }
    const kids = doc.resolve(d.get("Kids"));
    if (kids && kids.t === "arr") {
      for (let k = Math.min(kids.v.length, MAX_PAGES * 2) - 1; k >= 0; k -= 1) {
        const kid = kids.v[k];
        if (kid.t === "ref" && !seen.has(kid.n)) stack.push({ num: kid.n, depth: depth + 1 });
      }
    }
  }
  if (out.length > 0) return out;
  for (const [num, obj] of doc.objects) {
    if (out.length >= MAX_PAGES) break;
    if (nameOf(dictOf(obj.val)?.get("Type")) === "Page") out.push(num);
  }
  return out;
}

function pageResources(doc: Doc, page: Map<string, PdfVal>): Map<string, PdfVal> | null {
  let d: Map<string, PdfVal> | null = page;
  const seen = new Set<Map<string, PdfVal>>();
  for (let i = 0; d && i < 30 && !seen.has(d); i += 1) {
    seen.add(d);
    const res = dictOf(doc.resolve(d.get("Resources")) ?? null);
    if (res) return res;
    d = dictOf(doc.resolve(d.get("Parent")) ?? null);
  }
  return null;
}

function refsOf(arr: PdfVal[]): number[] {
  const out: number[] = [];
  for (const v of arr) if (v.t === "ref") out.push(v.n);
  return out;
}

function contentRefs(doc: Doc, page: Map<string, PdfVal>): number[] {
  const c = page.get("Contents");
  if (!c) return [];
  if (c.t === "arr") return refsOf(c.v);
  if (c.t === "ref") {
    const target = doc.objects.get(c.n);
    if (target && !target.stream && target.val?.t === "arr") return refsOf(target.val.v);
    return [c.n];
  }
  return [];
}

// ── fontes / ToUnicode ───────────────────────────────────────────────────────

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  let hi = -1;
  for (let k = 0; k < hex.length; k += 1) {
    const d = hexDigit(hex.charCodeAt(k));
    if (d < 0) continue;
    if (hi < 0) hi = d;
    else {
      out.push(hi * 16 + d);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return out;
}

function utf16be(bytes: number[]): string {
  let s = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  return s;
}

function codeOf(bytes: number[]): number {
  let acc = 0;
  for (const b of bytes.slice(-4)) acc = acc * 256 + b;
  return acc;
}

type CmapToken = { hex: string } | { arr: string[] };

/** Tokens de um bloco de CMap: hex `<..>` e arrays `[..]` (linear). */
function cmapTokens(block: string, budget: PdfBudget): CmapToken[] {
  const out: CmapToken[] = [];
  let i = 0;
  let arr: string[] | null = null;
  while (i < block.length) {
    budget.tick();
    const c = block.charCodeAt(i);
    if (c === 0x3c) {
      const end = block.indexOf(">", i + 1);
      if (end < 0) break;
      const hex = block.slice(i + 1, Math.min(end, i + 1 + 64));
      if (arr) {
        if (arr.length < MAX_RANGE) arr.push(hex);
      } else out.push({ hex });
      i = end + 1;
    } else if (c === 0x5b) {
      arr = [];
      i += 1;
    } else if (c === 0x5d) {
      if (arr) out.push({ arr });
      arr = null;
      i += 1;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Blocos `begin<kw> … end<kw>` por indexOf (linear, sem regex). */
function blocks(cmap: string, kw: string): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const start = cmap.indexOf(`begin${kw}`, pos);
    if (start < 0) break;
    const end = cmap.indexOf(`end${kw}`, start);
    if (end < 0) break;
    out.push(cmap.slice(start + kw.length + 5, end));
    pos = end + kw.length + 3;
  }
  return out;
}

/**
 * CMap ToUnicode (bfchar/bfrange) → mapa código → texto. Linear e com teto
 * GLOBAL de entradas por documento (`budget.cmapEntries`).
 */
export function parseToUnicode(cmap: string, budget: PdfBudget = new PdfBudget()): FontDecoder {
  const map = new Map<number, string>();
  const space = blocks(cmap, "codespacerange")[0];
  const firstHex = space ? cmapTokens(space, budget).find((t): t is { hex: string } => "hex" in t)?.hex : undefined;
  const bytesPerCode: 1 | 2 = firstHex && hexToBytes(firstHex).length >= 2 ? 2 : 1;
  const add = (code: number, value: string): boolean => {
    if (budget.cmapEntries >= MAX_CMAP_ENTRIES) return false;
    budget.cmapEntries += 1;
    map.set(code, value);
    return true;
  };
  charLoop: for (const block of blocks(cmap, "bfchar")) {
    const toks = cmapTokens(block, budget);
    for (let k = 0; k + 1 < toks.length; k += 2) {
      const a = toks[k];
      const b = toks[k + 1];
      if (!("hex" in a) || !("hex" in b)) continue;
      if (!add(codeOf(hexToBytes(a.hex)), utf16be(hexToBytes(b.hex)))) break charLoop;
    }
  }
  rangeLoop: for (const block of blocks(cmap, "bfrange")) {
    const toks = cmapTokens(block, budget);
    for (let k = 0; k + 2 < toks.length; k += 3) {
      budget.check();
      const lo = toks[k];
      const hi = toks[k + 1];
      const dst = toks[k + 2];
      if (!("hex" in lo) || !("hex" in hi)) continue;
      const loCode = codeOf(hexToBytes(lo.hex));
      const hiCode = codeOf(hexToBytes(hi.hex));
      if (hiCode < loCode || hiCode - loCode >= MAX_RANGE) continue;
      if ("hex" in dst) {
        const base = hexToBytes(dst.hex);
        for (let code = loCode; code <= hiCode; code += 1) {
          budget.tick();
          const bytes = [...base];
          let carry = code - loCode;
          for (let i = bytes.length - 1; i >= 0 && carry > 0; i -= 1) {
            const v = bytes[i] + carry;
            bytes[i] = v & 0xff;
            carry = v >> 8;
          }
          if (!add(code, utf16be(bytes))) break rangeLoop;
        }
      } else {
        for (let i = 0; i < dst.arr.length && loCode + i <= hiCode; i += 1) {
          if (!add(loCode + i, utf16be(hexToBytes(dst.arr[i])))) break rangeLoop;
        }
      }
    }
  }
  return { bytesPerCode, map };
}

function fontDecoders(doc: Doc, resources: Map<string, PdfVal> | null): Map<string, FontDecoder> {
  const out = new Map<string, FontDecoder>();
  const fonts = dictOf(doc.resolve(resources?.get("Font")) ?? null);
  if (!fonts) return out;
  for (const [name, ref] of fonts) {
    if (ref.t === "ref") out.set(name, doc.font(ref.n));
  }
  return out;
}

function decodeText(bytes: number[], font: FontDecoder | undefined): string {
  let s = "";
  if (!font || !font.map) {
    // Sem ToUnicode: 1 byte ≈ WinAnsi/Latin-1; 2 bytes (Identity) é ilegível.
    if (font && font.bytesPerCode === 2) return "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  const step = font.bytesPerCode;
  for (let i = 0; i + step - 1 < bytes.length; i += step) {
    const code = step === 2 ? (bytes[i] << 8) | bytes[i + 1] : bytes[i];
    s += font.map.get(code) ?? "";
  }
  return s;
}

// ── content stream ───────────────────────────────────────────────────────────

type Operand =
  | { t: "str"; v: number[] }
  | { t: "num"; v: number }
  | { t: "name"; v: string }
  | { t: "arr"; v: Operand[] }
  | { t: "other" };

const ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };

function readLiteral(s: string, i: number): { bytes: number[]; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  i += 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1] ?? "";
      if (n in ESCAPES) {
        bytes.push(ESCAPES[n]);
        i += 2;
      } else if (n >= "0" && n <= "7") {
        let j = i + 1;
        let oct = 0;
        let count = 0;
        while (j < s.length && count < 3 && s[j] >= "0" && s[j] <= "7") {
          oct = oct * 8 + (s.charCodeAt(j) - 48);
          j += 1;
          count += 1;
        }
        bytes.push(oct & 0xff);
        i = j;
      } else if (n === "\r" || n === "\n") {
        i += 2;
        if (n === "\r" && s[i] === "\n") i += 1;
      } else {
        i += 2;
      }
      continue;
    }
    if (c === "(") depth += 1;
    if (c === ")") {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    if (bytes.length < 65_536) bytes.push(s.charCodeAt(i) & 0xff);
    i += 1;
  }
  return { bytes, next: i };
}

function isNumberWord(word: string): boolean {
  if (word.length === 0 || word.length > 32) return false;
  let digits = 0;
  for (let k = 0; k < word.length; k += 1) {
    const c = word.charCodeAt(k);
    if (isDigit(c)) digits += 1;
    else if (!(c === 0x2e || ((c === 0x2b || c === 0x2d) && k === 0))) return false;
  }
  return digits > 0;
}

/** Interpreta os operadores de texto de UM content stream (linear). */
function contentStreamText(s: string, fonts: Map<string, FontDecoder>, budget: PdfBudget): string {
  const out: string[] = [];
  let size = 0;
  const stack: Operand[] = [];
  const arrays: Operand[][] = [];
  let font: FontDecoder | undefined;
  const push = (op: Operand) => {
    const target = arrays.length ? arrays[arrays.length - 1] : stack;
    if (target.length < 4096) target.push(op);
  };
  const emit = (text: string) => {
    out.push(text);
    size += text.length;
  };
  const show = (op: Operand | undefined) => {
    if (op?.t === "str") emit(decodeText(op.v, font));
    else if (op?.t === "arr") {
      for (const item of op.v) {
        if (item.t === "str") emit(decodeText(item.v, font));
        else if (item.t === "num" && item.v < -200) emit(" ");
      }
    }
  };
  let i = 0;
  while (i < s.length && size <= PDF_MAX_TEXT_CHARS) {
    budget.tick();
    const c = s.charCodeAt(i);
    if (isWs(c)) {
      i += 1;
      continue;
    }
    if (c === 0x25) {
      while (i < s.length && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i += 1;
      continue;
    }
    if (c === 0x28) {
      const lit = readLiteral(s, i);
      push({ t: "str", v: lit.bytes });
      i = lit.next;
      continue;
    }
    if (c === 0x3c && s.charCodeAt(i + 1) === 0x3c) {
      // Dicionário inline (marked content): pula com o parser linear.
      const parsed = parseValue({ s, budget, items: 0 }, i, 0);
      i = parsed ? Math.max(parsed.next, i + 2) : s.length;
      push({ t: "other" });
      continue;
    }
    if (c === 0x3c) {
      const end = s.indexOf(">", i);
      push({ t: "str", v: hexToBytes(s.slice(i + 1, end < 0 ? s.length : Math.min(end, i + 1 + 131_072))) });
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === 0x5b) {
      if (arrays.length < MAX_DEPTH) arrays.push([]);
      i += 1;
      continue;
    }
    if (c === 0x5d) {
      const arr = arrays.pop() ?? [];
      push({ t: "arr", v: arr });
      i += 1;
      continue;
    }
    if (c === 0x2f) {
      const j = readWord(s, i + 1);
      push({ t: "name", v: s.slice(i + 1, Math.min(j, i + 128)) });
      i = j;
      continue;
    }
    const j = readWord(s, i);
    if (j === i) {
      i += 1;
      continue;
    }
    const word = j - i > 32 ? "" : s.slice(i, j);
    i = j;
    if (isNumberWord(word)) {
      push({ t: "num", v: Number(word) });
      continue;
    }
    switch (word) {
      case "Tf": {
        const name = stack[stack.length - 2];
        if (name?.t === "name") font = fonts.get(name.v);
        break;
      }
      case "Tj":
      case "TJ":
        show(stack[stack.length - 1]);
        break;
      case "'":
      case '"':
        emit("\n");
        show(stack[stack.length - 1]);
        break;
      case "T*":
      case "ET":
      case "Tm":
        emit("\n");
        break;
      case "Td":
      case "TD": {
        const ty = stack[stack.length - 1];
        emit(ty?.t === "num" && ty.v !== 0 ? "\n" : " ");
        break;
      }
      case "ID": {
        const ei = s.indexOf("EI", i);
        i = ei < 0 ? s.length : ei + 2;
        break;
      }
      default:
        break;
    }
    stack.length = 0;
    arrays.length = 0;
  }
  return out.join("");
}

function tidy(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isEncrypted(src: Buffer, objects: Map<number, PdfObject>): boolean {
  if (src.includes("/Encrypt")) return true;
  for (const obj of objects.values()) {
    const d = dictOf(obj.val);
    if (d && nameOf(d.get("Filter")) === "Standard" && (d.has("O") || d.has("U"))) return true;
  }
  return false;
}

function expandObjectStreams(doc: Doc, budget: PdfBudget): void {
  const objects = doc.objects;
  for (const [num, obj] of [...objects]) {
    const d = dictOf(obj.val);
    if (!d || nameOf(d.get("Type")) !== "ObjStm") continue;
    const n = d.get("N");
    const first = d.get("First");
    if (n?.t !== "num" || first?.t !== "num") continue;
    const data = doc.stream(num);
    if (!data) continue;
    const text = data.toString("latin1");
    const header: number[] = [];
    let p = 0;
    const st: ParseState = { s: text, budget, items: 0 };
    for (let k = 0; k < Math.min(n.v, MAX_OBJECTS) * 2; k += 1) {
      const v = parseValue(st, p, 0);
      if (!v || v.val.t !== "num" || v.next > first.v) break;
      header.push(v.val.v);
      p = v.next;
    }
    for (let k = 0; k + 1 < header.length && objects.size < MAX_OBJECTS; k += 2) {
      if (objects.has(header[k])) continue;
      const v = parseValue({ s: text, budget, items: 0 }, first.v + header[k + 1], 0);
      if (v) objects.set(header[k], { val: v.val, stream: null });
    }
  }
}

/**
 * Bytes de um PDF → texto (ou `scanned`/`unsupported`). Nunca lança; respeita
 * o orçamento de tempo e os tetos agregados (estourou → `unsupported`).
 */
export function extractPdfText(bytes: Uint8Array, budget: PdfBudget = new PdfBudget()): PdfTextResult {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!buf.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
      return { kind: "unsupported", reason: "not_pdf" };
    }
    const objects = parseObjects(buf, budget);
    const doc = new Doc(objects, budget);
    expandObjectStreams(doc, budget);
    if (isEncrypted(buf, objects)) return { kind: "unsupported", reason: "encrypted" };

    const texts: string[] = [];
    let size = 0;
    for (const num of orderedPages(doc)) {
      budget.check();
      const page = dictOf(objects.get(num)?.val ?? null);
      if (!page) continue;
      const fonts = fontDecoders(doc, pageResources(doc, page));
      const pageText = tidy(
        contentRefs(doc, page)
          .map((ref) => doc.content(ref, fonts))
          .join("\n"),
      );
      texts.push(pageText);
      size += pageText.length;
      if (size > PDF_MAX_TEXT_CHARS) break;
    }
    const text = texts.filter(Boolean).join("\n\n").slice(0, PDF_MAX_TEXT_CHARS);
    if (text.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
      const hasImage = [...objects.values()].some((o) => nameOf(dictOf(o.val)?.get("Subtype")) === "Image");
      return hasImage ? { kind: "scanned" } : { kind: "unsupported", reason: "no_text" };
    }
    return { kind: "text", text };
  } catch (error) {
    if (error instanceof BudgetExceeded) return { kind: "unsupported", reason: error.reason };
    return { kind: "unsupported", reason: "parse_error" };
  }
}
