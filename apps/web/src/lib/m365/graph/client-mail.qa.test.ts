import { describe, expect, it, vi } from "vitest";
import { MESSAGE_QUERY_LIMIT, createHttpGraphClient, subjectSearchTerm } from "./client";

/**
 * QA M2 — cliente Graph HTTP nas consultas de e-mail (fetch mockado; nada
 * real). Busca estreita, só `/me`, sem corpo na listagem, 429/Retry-After.
 */

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

function tokens() {
  return { get: vi.fn(async () => "T0"), refresh: vi.fn(async () => "T1") };
}

function capture(reply: () => Response = () => json(200, { value: [] })) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fetch = vi.fn(async (u: string, init?: RequestInit) => {
    urls.push(u);
    inits.push(init!);
    return reply();
  });
  return { fetch, urls, inits };
}

const SINCE = "2026-11-24T13:00:00.000Z";
const UNTIL = "2026-11-26T15:00:00.000Z";

describe("findMessages — consulta estreita na caixa do PRÓPRIO usuário", () => {
  it("categoria: /me/messages com $filter de categoria + janela, $top 25 e $select sem corpo", async () => {
    const c = capture();
    await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).findMessages({
      kind: "category",
      category: "JumpFlow",
      since: SINCE,
      until: UNTIL,
    });
    const url = new URL(c.urls[0]);
    expect(url.origin + url.pathname).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(url.searchParams.get("$top")).toBe(String(MESSAGE_QUERY_LIMIT));
    const select = url.searchParams.get("$select")!.split(",");
    for (const banned of ["body", "uniqueBody", "bodyPreview"]) expect(select).not.toContain(banned);
    expect(url.searchParams.get("$filter")).toBe(
      `categories/any(c:c eq 'JumpFlow') and receivedDateTime ge ${SINCE} and receivedDateTime le ${UNTIL}`,
    );
  });

  it("categoria com aspa é escapada (sem injeção OData)", async () => {
    const c = capture();
    await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).findMessages({
      kind: "category",
      category: "x') or (true",
      since: SINCE,
      until: UNTIL,
    });
    expect(new URL(c.urls[0]).searchParams.get("$filter")).toContain("c eq 'x'') or (true'");
  });

  it("assunto: $search KQL só com letras/dígitos dentro de aspas (operadores e campos do atacante neutralizados)", async () => {
    const c = capture();
    const hostile = `1:1 Ana" OR from:ceo@jump.com.br OR subject:"salário (confidencial) *`;
    await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).findMessages({
      kind: "subject",
      subject: hostile,
      since: SINCE,
      until: UNTIL,
    });
    const url = new URL(c.urls[0]);
    const search = url.searchParams.get("$search")!;
    expect(search.startsWith('"subject:')).toBe(true);
    expect(search.endsWith('"')).toBe(true);
    const inner = search.slice('"subject:'.length, -1);
    expect(inner).not.toMatch(/["():*@]/);
    expect(url.searchParams.get("$filter")).toBeNull();
    expect(subjectSearchTerm("a".repeat(500)).length).toBeLessThanOrEqual(200 + '"subject:"'.length);
  });

  it("corta em 25 resultados e descarta itens sem id", async () => {
    const value = [{ subject: "sem id" }, ...Array.from({ length: 40 }, (_, i) => ({ id: `m${i}` }))];
    const c = capture(() => json(200, { value }));
    const out = await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).findMessages({
      kind: "category",
      category: "JumpFlow",
      since: SINCE,
      until: UNTIL,
    });
    expect(out).toHaveLength(MESSAGE_QUERY_LIMIT);
    expect(out.every((m) => typeof m.id === "string" && m.id)).toBe(true);
  });

  it("429 com Retry-After na busca é respeitado; esgotado → throttled", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "4" }))
      .mockResolvedValueOnce(json(200, { value: [{ id: "m1" }] }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch, sleep });
    await expect(client.findMessages({ kind: "subject", subject: "1:1 Ana", since: SINCE, until: UNTIL })).resolves.toHaveLength(1);
    expect(sleep).toHaveBeenCalledWith(4000);

    const always = vi.fn(async () => json(429, {}, { "retry-after": "1" }));
    const tired = createHttpGraphClient({ tokens: tokens(), fetch: always, sleep: async () => {}, maxRetries: 1 });
    await expect(tired.getAttachment("m1", "a1")).rejects.toMatchObject({ kind: "throttled" });
  });
});

describe("leitura da mensagem escolhida", () => {
  it("corpo: Prefer body-content-type=text, só body/uniqueBody, corte de tamanho", async () => {
    const huge = "x".repeat(600 * 1024);
    const c = capture(() =>
      json(200, { body: { contentType: "html", content: huge }, uniqueBody: { contentType: "text", content: "novo" } }),
    );
    const body = await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).getMessageBody("AAMk-1=");
    expect((c.inits[0].headers as Record<string, string>).Prefer).toContain('outlook.body-content-type="text"');
    const url = new URL(c.urls[0]);
    expect(url.pathname).toBe("/v1.0/me/messages/AAMk-1%3D");
    expect(url.searchParams.get("$select")).toBe("body,uniqueBody");
    expect(body.content.length).toBe(512 * 1024);
    expect(body).toMatchObject({ contentType: "html", uniqueContentType: "text", uniqueContent: "novo" });
  });

  it("anexo: base64 decodificado em memória; tipo item/reference reconhecido", async () => {
    const c = capture(() =>
      json(200, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: "a1",
        name: "ata.pdf",
        contentType: "application/pdf",
        size: 3,
        isInline: false,
        contentBytes: Buffer.from("abc").toString("base64"),
      }),
    );
    const att = await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).getAttachment("m/1", "a?1");
    expect(Buffer.from(att.bytes).toString()).toBe("abc");
    expect(new URL(c.urls[0]).pathname).toBe("/v1.0/me/messages/m%2F1/attachments/a%3F1");

    const list = capture(() =>
      json(200, {
        value: [
          { "@odata.type": "#microsoft.graph.itemAttachment", id: "i1", name: "msg", size: 10 },
          { "@odata.type": "#microsoft.graph.referenceAttachment", id: "r1", name: "link", size: 10 },
          { id: "", name: "sem id" },
        ],
      }),
    );
    const metas = await createHttpGraphClient({ tokens: tokens(), fetch: list.fetch }).listAttachments("m1");
    expect(metas.map((m) => [m.id, m.kind])).toEqual([
      ["i1", "item"],
      ["r1", "reference"],
    ]);
  });

  it("ids com '/', '?', '#' e '%' nunca saem do caminho /me/messages/{id}", async () => {
    for (const id of ["../../users/outro@jump.com.br/messages/x", "x?$select=body", "x#frag", "%2e%2e", "a/b"]) {
      const c = capture(() => json(200, { id: "x" }));
      await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).getMessage(id);
      const url = new URL(c.urls[0]);
      expect(url.pathname.startsWith("/v1.0/me/messages/")).toBe(true);
      expect(url.pathname.split("/")).toHaveLength(5);
    }
  });

  // ACHADO (menor): `encodeURIComponent` não escapa "." — um messageId "." ou
  // ".." vira segmento de ponto e o WHATWG URL normaliza o caminho
  // (/me/messages/.. → /me/). Fica restrito ao /me do próprio gestor e cai em
  // `not_candidate`, mas o id deveria ser validado (charset de id do Graph).
  it("messageId '..' não escapa de /me/messages", async () => {
    const c = capture(() => json(200, { id: "x" }));
    await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).getMessage("..");
    expect(new URL(c.urls[0]).pathname.startsWith("/v1.0/me/messages/")).toBe(true);
  });
});
