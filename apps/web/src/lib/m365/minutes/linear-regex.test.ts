import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseExtraction } from "@/lib/checkpoint/extraction";
import { subjectSearchTerm } from "../graph/client";
import { cleanEmailBody, decodeEntities, htmlToText, isForwardSubject, messageBodyToText } from "./body";
import { docxXmlToText, extractDocxText } from "./docx";
import { parseMinutes } from "./generate";
import { emptyPiiMap, maskPii, unmaskPii } from "./pii";
import { isMeetingResponseSubject, normalizeSubject, subjectMatches } from "./select";
import { stripCodeFence, tidyText, truncateAtSpace } from "./text-safe";

/**
 * Entrada hostil contra TODA regex/replace aplicada a texto não confiável
 * (corpo, assunto, anexos, saída da IA). Cada caso precisa terminar em < 1 s;
 * as versões antigas levavam de segundos a minutos (validador da M2).
 */

const N = 200_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
}

function fast<T>(fn: () => T): T {
  const { value, ms } = timed(fn);
  expect(ms).toBeLessThan(1000);
  return value;
}

describe("DOCX (varredor com indexOf + orçamento de tempo)", () => {
  it("tag <w:t aberta repetida (zip de poucos bytes) termina rápido", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:t x".repeat(40_000));
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const { value, ms } = await timedAsync(() => extractDocxText(bytes));
    expect(value).toBe("");
    expect(ms).toBeLessThan(1000);
  });

  it("<w:tab/> repetido e <w:t> sem fechamento", () => {
    expect(fast(() => docxXmlToText("<w:p><w:tab/>".repeat(N))).length).toBeLessThanOrEqual(200_000);
    fast(() => docxXmlToText(`<w:t>${"a".repeat(N)}`));
    fast(() => docxXmlToText(`<w:t ${"x".repeat(N)}`));
    fast(() => docxXmlToText(`<${" ".repeat(N)}>`));
  });

  it("orçamento de tempo estourado aborta", () => {
    let calls = 0;
    const clock = () => (calls++ === 0 ? 0 : 10_000);
    expect(() => docxXmlToText("<w:p></w:p>".repeat(5000), clock)).toThrow("docx_time_budget");
  });

  it("entidades com letras/dígitos longos", () => {
    fast(() => docxXmlToText(`<w:t>&${"#x".repeat(1)}${"f".repeat(N)}</w:t>`));
  });
});

describe("maskPii (quantificadores limitados + lookbehind)", () => {
  it.each([
    ["200k letras", "a".repeat(N)],
    ["a@ + 200k letras", `a@${"b".repeat(N)}`],
    ["200k letras + @", `${"b".repeat(N)}@x`],
    ["letras.pontos", "a.".repeat(N / 2)],
    ["a@b. repetido", "a@b.".repeat(N / 4)],
    ["200k dígitos", "1".repeat(N)],
    ["dígitos e espaços", "1 ".repeat(N / 2)],
    ["dígitos e pontos", "12.".repeat(N / 3)],
    ["parênteses/DDD", "(11) ".repeat(N / 5)],
    ["+55 repetido", "+55 ".repeat(N / 4)],
    ["barras de CNPJ", "12/".repeat(N / 3)],
  ])("%s", (_label, text) => {
    fast(() => maskPii(text));
  });

  it("continua achando e-mails válidos (incluindo subdomínio e TLD longo)", () => {
    expect(maskPii("a ana.silva+x@mail.cliente.com.br e b@x.technology.").masked).toBe("a [EMAIL_1] e [EMAIL_2].");
    expect(maskPii("sem tld a@b").masked).toBe("sem tld a@b");
  });

  it("unmaskPii com marcadores quase válidos repetidos", () => {
    fast(() => unmaskPii("[EMAIL_".repeat(N / 7), emptyPiiMap()));
  });
});

describe("corpo / assunto", () => {
  it("cleanEmailBody com 200k espaços/tabs (antes 17 s)", () => {
    fast(() => cleanEmailBody(" ".repeat(N)));
    fast(() => cleanEmailBody(" \t".repeat(N / 2)));
    fast(() => cleanEmailBody(`${" ".repeat(N)}x\n`));
    fast(() => cleanEmailBody(`${"\n".repeat(N)}`, { keepQuoted: true }));
    fast(() => cleanEmailBody(`De: x\n${"> ".repeat(N)}`, { keepQuoted: true }));
    fast(() => cleanEmailBody(`Em ${" ".repeat(N)} escreveu:`));
  });

  it("tidyText/truncateAtSpace lineares", () => {
    expect(fast(() => tidyText(`a${" ".repeat(N)}\n\n\n\nb`))).toBe("a\n\nb");
    expect(truncateAtSpace("abc def ghi", 5)).toBe("abc");
  });

  it("decodeEntities e htmlToText com & / < repetidos e entidades longas", () => {
    fast(() => decodeEntities(`&${"a".repeat(N / 2)}${"1".repeat(N / 2)}`));
    fast(() => decodeEntities("&#".repeat(N / 2)));
    fast(() => htmlToText("<".repeat(N)));
    fast(() => htmlToText("<blockquote".repeat(N / 11)));
    fast(() => messageBodyToText({ contentType: "html", content: "<p>".repeat(N / 3), uniqueContentType: null, uniqueContent: null }, { subject: "ENC: x" }));
  });

  it("assunto: prefixos RE/ENC com espaços longos, convites e busca", () => {
    const hostile = `re${" ".repeat(N)}x`;
    fast(() => normalizeSubject(hostile));
    fast(() => normalizeSubject("re: ".repeat(N / 4)));
    fast(() => isForwardSubject(`re${" ".repeat(N)}`));
    fast(() => isMeetingResponseSubject(`aceito${" ".repeat(N)}`));
    fast(() => subjectMatches("a ".repeat(N / 2), "a ".repeat(N / 2)));
    fast(() => subjectSearchTerm("!".repeat(N)));
  });
});

describe("saída da IA (cercas de código)", () => {
  it("parseMinutes/parseExtraction com 200k espaços sem cerca final", () => {
    const raw = `{"summary":"x"${" ".repeat(N)}x`;
    expect(fast(() => parseMinutes(raw)).ok).toBe(false);
    expect(fast(() => parseExtraction(raw)).ok).toBe(false);
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence("```\n{}\n```")).toBe("{}");
  });
});
