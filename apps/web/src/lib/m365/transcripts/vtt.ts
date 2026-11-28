/**
 * Transcrição do Teams (M365 M3): WebVTT → "Nome: fala". PURO e LINEAR.
 *
 * O VTT e os nomes de falantes são texto de TERCEIROS (qualquer participante
 * fala/renomeia-se): nada aqui usa regex. Tudo é varredura manual com
 * `indexOf`/laços que visitam cada caractere um número constante de vezes, e
 * tetos de tamanho são aplicados ANTES de qualquer processamento:
 *
 * - entrada cortada em {@link VTT_MAX_CHARS};
 * - cada linha: crua lida até {@link VTT_RAW_LINE_MAX_CHARS}, tags removidas
 *   ANTES de qualquer corte do texto, depois cortada em {@link VTT_MAX_LINE_CHARS};
 * - nome do falante em {@link SPEAKER_MAX_CHARS};
 *   (todos os cortes acima são `truncateAtSpace`: recuam até um espaço e
 *   descartam cauda numérica — nunca deixam fragmento de dado pessoal cru
 *   antes da máscara);
 * - no máximo {@link MAX_UTTERANCES} falas;
 * - saída em {@link SPEAKER_TEXT_MAX_CHARS} (70% início / 30% fim, por LINHA
 *   inteira — uma fala nunca é partida, então nenhum dado pessoal é cortado ao
 *   meio antes da máscara).
 *
 * Formato do Teams:
 *
 *   WEBVTT
 *
 *   0f6c…/12-0
 *   00:00:03.120 --> 00:00:05.000
 *   <v Ana Souza>Bom dia a todos.</v>
 *
 * Saída: uma linha por fala ("Ana Souza: Bom dia a todos."), falas seguidas da
 * mesma pessoa juntas. Sem horário, id de cue, NOTE/STYLE/REGION. O VTT bruto
 * nunca é persistido: só existe em memória durante a rodada.
 */

import { dropPartialTail, safeTailSlice, truncateAtSpace } from "../minutes/text-safe";

export const VTT_MAX_CHARS = 6_000_000;
export const VTT_MAX_LINE_CHARS = 4_000;
/** Teto da linha CRUA (com tags) lida antes de limpar; acima disso a cauda é descartada. */
export const VTT_RAW_LINE_MAX_CHARS = 64_000;
export const SPEAKER_MAX_CHARS = 80;
export const MAX_UTTERANCES = 50_000;
export const SPEAKER_TEXT_MAX_CHARS = 300_000;
/** Distância máxima entre `<` e `>` para ser tratado como tag. */
const TAG_MAX_CHARS = 200;
export const SPEAKER_TEXT_MARKER = "[… trecho do meio da reunião omitido por tamanho …]";
/** Marcador dentro de UMA fala longa demais (70/30 dentro dela). */
export const SPEECH_MARKER = "[… trecho da fala omitido …]";

export interface TranscriptUtterance {
  speaker: string | null;
  text: string;
}

export interface ParsedVtt {
  utterances: TranscriptUtterance[];
  /** A entrada passou de algum teto (algo foi descartado). */
  truncated: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  lrm: "",
  rlm: "",
};

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b || c === 0xa0;
}

/** Controle (exceto espaços) e caracteres de formatação bidi/zero-width. */
function isInvisible(c: number): boolean {
  return (
    (c < 0x20 && !isWs(c)) ||
    c === 0x7f ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff
  );
}

/**
 * Remove tags `<...>` (de qualquer tamanho). Linear: o próximo `>` é
 * procurado só quando a posição já passou do último encontrado, então as
 * buscas nunca se sobrepõem ("<<<<…" sem `>` custa uma varredura só).
 */
export function stripTags(input: string): string {
  let out = "";
  let i = 0;
  let nextGt = -2;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf("<", i);
    if (lt < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, lt);
    if (nextGt !== -1 && nextGt < lt) nextGt = input.indexOf(">", lt);
    if (nextGt === -1) {
      // Nenhum `>` daqui em diante: tag aberta (no VTT um `<` literal vem como
      // `&lt;`). O resto é descartado — nunca vira fragmento de dado.
      break;
    }
    // No VTT todo `<` cru é marcação (o literal vem como `&lt;`): a tag sai
    // inteira, por maior que seja (salto direto ao `>`, linear).
    i = nextGt + 1;
  }
  return out;
}

/** Decodifica entidades HTML comuns. Lookahead limitado (≤ 10) em cada `&`. */
export function decodeEntities(input: string): string {
  if (input.indexOf("&") < 0) return input;
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const amp = input.indexOf("&", i);
    if (amp < 0) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, amp);
    let semi = -1;
    for (let k = amp + 1; k < n && k <= amp + 10; k += 1) {
      if (input.charCodeAt(k) === 0x3b) {
        semi = k;
        break;
      }
    }
    if (semi < 0) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const name = input.slice(amp + 1, semi);
    let decoded: string | null = null;
    if (name.length > 1 && name.charCodeAt(0) === 0x23) {
      const hex = name.charCodeAt(1) === 0x78 || name.charCodeAt(1) === 0x58;
      const digits = hex ? name.slice(2) : name.slice(1);
      let valid = digits.length > 0;
      for (let k = 0; k < digits.length && valid; k += 1) {
        const c = digits.charCodeAt(k);
        const isDec = c >= 0x30 && c <= 0x39;
        const isHex = isDec || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
        valid = hex ? isHex : isDec;
      }
      const code = valid ? parseInt(digits, hex ? 16 : 10) : NaN;
      decoded = Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    } else {
      const named = NAMED_ENTITIES[name.toLowerCase()];
      decoded = named === undefined ? null : named;
    }
    if (decoded === null) {
      out += "&";
      i = amp + 1;
      continue;
    }
    out += decoded;
    i = semi + 1;
  }
  return out;
}

/** Remove invisíveis, colapsa espaços em um só e apara. Linear. */
export function collapseSpaces(input: string): string {
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (isWs(c)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (isInvisible(c)) continue;
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += input[i];
  }
  return out;
}

/** Nome do falante: sem tags/invisíveis, sem `:` (separador da saída), ≤ 80. */
export function sanitizeSpeaker(raw: string): string | null {
  const clean = collapseSpaces(decodeEntities(stripTags(raw.slice(0, VTT_MAX_LINE_CHARS))).split(":").join(" "));
  const name = truncateAtSpace(clean, SPEAKER_MAX_CHARS).trim();
  return name ? name : null;
}

function cleanText(raw: string): string {
  return collapseSpaces(decodeEntities(stripTags(raw)));
}

function startsWithWord(line: string, word: string): boolean {
  if (!line.startsWith(word)) return false;
  if (line.length === word.length) return true;
  return isWs(line.charCodeAt(word.length));
}

/**
 * Uma linha de texto de cue: `<v Nome>fala</v>` ou continuação. As tags saem
 * ANTES de qualquer corte; `rawCut` = a linha crua foi cortada (fim
 * desconhecido) → o último bloco/cauda numérica é descartado.
 */
function parseCueLine(
  line: string,
  currentSpeaker: string | null,
  rawCut: boolean,
): { speaker: string | null; text: string; truncated: boolean } {
  let speaker = currentSpeaker;
  let rest = line;
  // `<v Nome>` ou `<v.classe Nome>`; nome só com o `>` perto (≤ 200).
  if (line.length > 2 && line.charCodeAt(0) === 0x3c && (line.charCodeAt(1) === 0x76 || line.charCodeAt(1) === 0x56)) {
    const after = line.charCodeAt(2);
    if (isWs(after) || after === 0x2e) {
      const gt = line.indexOf(">", 2);
      // Anotação de voz malformada (`<` dentro de `<v …>`): não dá para saber
      // onde termina o nome nem onde começa a fala — a linha inteira é
      // descartada (um nome/dado partido nunca vai cru à IA).
      if (gt > 0 && line.lastIndexOf("<", gt) > 0) {
        return { speaker: null, text: "", truncated: true };
      }
      if (gt > TAG_MAX_CHARS + 2) {
        // Nome longo demais: sem falante; a fala começa depois do `>`.
        speaker = null;
        rest = line.slice(gt + 1);
      } else if (gt > 0) {
        let inner = line.slice(2, gt);
        if (after === 0x2e) {
          // Classe(s) até o primeiro espaço; o nome vem depois.
          let k = 0;
          while (k < inner.length && !isWs(inner.charCodeAt(k))) k += 1;
          inner = inner.slice(k);
        }
        speaker = sanitizeSpeaker(inner);
        rest = line.slice(gt + 1);
      }
    }
  }
  let text = cleanText(rest);
  if (rawCut) text = dropPartialTail(text);
  const truncated = rawCut || text.length > VTT_MAX_LINE_CHARS;
  if (text.length > VTT_MAX_LINE_CHARS) text = truncateAtSpace(text, VTT_MAX_LINE_CHARS);
  return { speaker, text, truncated };
}

/**
 * WebVTT → falas. Texto sem nenhuma linha de horário (`-->`) não é VTT e não
 * produz falas. LINEAR.
 */
export function parseVtt(vtt: string): ParsedVtt {
  let src = String(vtt ?? "");
  let truncated = false;
  let srcCut = false;
  if (src.length > VTT_MAX_CHARS) {
    // Corte cru: a última linha é tratada como cortada (cauda descartada após
    // remover as tags).
    src = src.slice(0, VTT_MAX_CHARS);
    truncated = true;
    srcCut = true;
  }
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const utterances: TranscriptUtterance[] = [];
  let inCue = false;
  let inBlock = false;
  let cueSpeaker: string | null = null;
  let start = 0;
  while (start <= src.length) {
    let end = src.indexOf("\n", start);
    if (end < 0) end = src.length;
    // Linha crua limitada; tags e cortes do TEXTO acontecem depois (parseCueLine).
    const rawCut = end - start > VTT_RAW_LINE_MAX_CHARS || (srcCut && end === src.length);
    let line = src.slice(start, Math.min(end, start + VTT_RAW_LINE_MAX_CHARS));
    start = end + 1;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    const trimmed = line.trim();
    if (trimmed === "") {
      inCue = false;
      inBlock = false;
      cueSpeaker = null;
      continue;
    }
    if (inBlock) continue;
    if (!inCue) {
      if (startsWithWord(trimmed, "WEBVTT") || startsWithWord(trimmed, "NOTE") || startsWithWord(trimmed, "STYLE") || startsWithWord(trimmed, "REGION")) {
        inBlock = true;
        continue;
      }
      if (trimmed.indexOf("-->") >= 0) {
        inCue = true;
        cueSpeaker = null;
      }
      // Senão: identificador do cue (ou lixo antes do horário) — ignorado.
      continue;
    }
    if (trimmed.indexOf("-->") >= 0) continue;
    const parsed = parseCueLine(trimmed, cueSpeaker, rawCut);
    truncated ||= parsed.truncated;
    cueSpeaker = parsed.speaker;
    if (!parsed.text) continue;
    const last = utterances[utterances.length - 1];
    if (last && last.speaker === parsed.speaker) {
      // Teto por fala: o texto total já é limitado pela entrada.
      last.text = `${last.text} ${parsed.text}`;
    } else {
      if (utterances.length >= MAX_UTTERANCES) {
        truncated = true;
        break;
      }
      utterances.push({ speaker: parsed.speaker, text: parsed.text });
    }
  }
  return { utterances, truncated };
}

export interface SpeakerText {
  text: string;
  /** Falas omitidas pelo teto de saída (ou entrada cortada). */
  truncated: boolean;
  utterances: number;
  speakers: number;
}

/**
 * Falas → "Nome: fala" (uma por linha). Acima de `max`, mantém 70% do início e
 * 30% do fim por LINHAS INTEIRAS, com marcador no meio. Uma fala que SOZINHA
 * passa de metade do orçamento (monólogo, VTT sem `<v>`) é antes cortada 70/30
 * DENTRO dela, em fronteiras seguras — nunca some inteira. LINEAR.
 */
export function utterancesToText(
  utterances: TranscriptUtterance[],
  max: number = SPEAKER_TEXT_MAX_CHARS,
): { text: string; truncated: boolean } {
  let total = 0;
  for (const u of utterances) total += (u.speaker ? u.speaker.length + 2 : 0) + u.text.length + 1;
  const asLine = (u: TranscriptUtterance) => (u.speaker ? `${u.speaker}: ${u.text}` : u.text);
  if (total <= max) return { text: utterances.map(asLine).join("\n"), truncated: false };
  const budget = Math.max(0, max - SPEAKER_TEXT_MARKER.length - 2);
  const lineCap = Math.floor(budget / 2);
  const lines = utterances.map((u) => {
    const prefix = u.speaker ? `${u.speaker}: ` : "";
    if (prefix.length + u.text.length <= lineCap) return prefix + u.text;
    const room = Math.max(0, lineCap - prefix.length - SPEECH_MARKER.length - 2);
    const head = truncateAtSpace(u.text, Math.floor(room * 0.7));
    const tail = safeTailSlice(u.text, room - Math.floor(room * 0.7));
    return `${prefix}${head} ${SPEECH_MARKER} ${tail}`;
  });
  const headBudget = Math.floor(budget * 0.7);
  const tailBudget = budget - headBudget;
  const head: string[] = [];
  let used = 0;
  let h = 0;
  for (; h < lines.length; h += 1) {
    if (used + lines[h].length + 1 > headBudget) break;
    head.push(lines[h]);
    used += lines[h].length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let t = lines.length - 1; t >= h; t -= 1) {
    if (used + lines[t].length + 1 > tailBudget) break;
    tail.push(lines[t]);
    used += lines[t].length + 1;
  }
  tail.reverse();
  return { text: [...head, SPEAKER_TEXT_MARKER, ...tail].join("\n"), truncated: true };
}

/** VTT (um ou mais, na ordem) → texto "Nome: fala" com contadores. PURA. */
export function vttToSpeakerText(vtts: string[], max: number = SPEAKER_TEXT_MAX_CHARS): SpeakerText {
  const all: TranscriptUtterance[] = [];
  let truncated = false;
  for (const vtt of vtts) {
    const parsed = parseVtt(vtt);
    truncated ||= parsed.truncated;
    for (const u of parsed.utterances) {
      const last = all[all.length - 1];
      if (last && last.speaker === u.speaker) last.text = `${last.text} ${u.text}`;
      else all.push(u);
    }
  }
  const speakers = new Set(all.map((u) => u.speaker).filter((s): s is string => s !== null)).size;
  const out = utterancesToText(all, max);
  return { text: out.text, truncated: truncated || out.truncated, utterances: all.length, speakers };
}
