import { describe, expect, it } from "vitest";
import { maskPii } from "./pii";
import { dropPartialTail, safeTailSlice, truncateAtSpace } from "./text-safe";

/**
 * Remanescente da M2 (veredito do validador): o corte de defesa roda ANTES da
 * máscara e não pode deixar fragmento de dado pessoal cru para a IA.
 */
describe("truncateAtSpace nunca parte um dado pessoal", () => {
  it("bloco sem espaço que cruza o teto é descartado inteiro, mesmo a > 200 posições", () => {
    const text = `Contato: ${"joao.pereira".repeat(40)}@cliente.com.br fim`;
    const cut = truncateAtSpace(text, 200);
    expect(cut).toBe("Contato:");
  });

  it("sem nenhum espaço antes do teto → vazio (nunca um fragmento)", () => {
    expect(truncateAtSpace("x".repeat(1000), 300)).toBe("");
  });

  it("telefone/CPF com espaços internos cortado no meio: a cauda numérica sai", () => {
    expect(truncateAtSpace("Ligue (11) 98765-4321 amanhã", 16)).toBe("Ligue");
    expect(truncateAtSpace("CPF 123 456 789 09 ok", 13)).toBe("CPF");
    expect(truncateAtSpace("CPF 123.456.789-09 ok", 10)).toBe("CPF");
  });

  it("o que sobra nunca tem dígitos de dado sem máscara no fim", () => {
    const base = "Fale com ana@cliente.com.br ou (11) 98765-4321, CPF 123.456.789-09 e CNPJ 12.345.678/0001-90 hoje.";
    for (let max = 1; max < base.length; max += 1) {
      const cut = truncateAtSpace(base, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(base.startsWith(cut)).toBe(true);
      const { masked } = maskPii(cut);
      // Nenhum pedaço de e-mail/número sobra sem máscara.
      expect(masked).not.toMatch(/\d{2,}/);
      expect(masked).not.toMatch(/@/);
    }
  });

  it("corte exatamente antes de um espaço mantém a última palavra; texto curto intacto", () => {
    expect(truncateAtSpace("abc def ghi", 7)).toBe("abc def");
    expect(truncateAtSpace("abc def ghi", 5)).toBe("abc");
    expect(truncateAtSpace("curto", 100)).toBe("curto");
  });

  it("linear: 2M caracteres sem espaço e 2M dígitos com espaço", () => {
    const t0 = performance.now();
    truncateAtSpace("a".repeat(2_000_000), 1_500_000);
    truncateAtSpace("1 ".repeat(1_000_000), 1_500_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("dropPartialTail / safeTailSlice (cortes do fim e do início)", () => {
  it("dropPartialTail descarta o último bloco e a cauda numérica", () => {
    expect(dropPartialTail("ligue (11) 98765-43")).toBe("ligue");
    expect(dropPartialTail("contato ana.sou")).toBe("contato");
  });

  it("safeTailSlice nunca começa no meio de um dado, em qualquer posição", () => {
    const base = "Fale com ana@cliente.com.br ou (11) 98765-4321, CPF 123.456.789-09 e CNPJ 12.345.678/0001-90 hoje.";
    for (let max = 0; max <= base.length; max += 1) {
      const cut = safeTailSlice(base, max);
      expect(cut.length).toBeLessThanOrEqual(max);
      expect(base.endsWith(cut)).toBe(true);
      const rest = maskPii(cut).masked.replace(/\[(?:EMAIL|CNPJ|CPF|TELEFONE)_\d+\]/g, "");
      expect(rest).not.toMatch(/[\d@]/);
    }
  });

  it("lineares em 2M caracteres", () => {
    const t0 = performance.now();
    dropPartialTail("a".repeat(2_000_000));
    safeTailSlice("1 ".repeat(1_000_000), 1_500_000);
    safeTailSlice("b".repeat(2_000_000), 10);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
