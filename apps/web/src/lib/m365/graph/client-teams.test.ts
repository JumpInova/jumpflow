import { describe, expect, it, vi } from "vitest";
import {
  CONTENT_TOO_LARGE,
  JOIN_URL_MAX_CHARS,
  createHttpGraphClient,
  onlineMeetingFilterUrl,
} from "./client";
import { GraphError } from "./errors";

/**
 * M3 — cliente Graph HTTP nas reuniões online/transcrições (fetch mockado;
 * nada real). Encoding do filtro por JoinWebUrl, só `/me`, teto do VTT.
 */

const JOIN =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzA1Y2Q%40thread.v2/0?context=%7b%22Tid%22%3a%2211111111-2222%22%2c%22Oid%22%3a%22abc%22%7d";

function tokens() {
  return { get: vi.fn(async () => "T0"), refresh: vi.fn(async () => "T1") };
}

function capture(reply: (url: string) => Response) {
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fetch = vi.fn(async (u: string, init?: RequestInit) => {
    urls.push(u);
    inits.push(init!);
    return reply(u);
  });
  return { fetch, urls, inits };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("onlineMeetingFilterUrl — encoding do JoinWebUrl", () => {
  it("link usado como veio, aspas OData, $filter codificado UMA vez (%3a → %253a, espaço → %20, nunca '+')", () => {
    const url = onlineMeetingFilterUrl(JOIN)!;
    expect(url.startsWith("https://graph.microsoft.com/v1.0/me/onlineMeetings?$filter=JoinWebUrl%20eq%20'https%3A%2F%2Fteams.microsoft.com")).toBe(true);
    expect(url).toContain("19%253ameeting_NzA1Y2Q%2540thread.v2");
    expect(url).not.toContain("+");
    expect(url.endsWith("'&$select=id,joinWebUrl,participants")).toBe(true);
    // Decodificar o $filter devolve exatamente o literal OData com o link original.
    const raw = url.slice(url.indexOf("$filter=") + 8, url.indexOf("&$select"));
    expect(decodeURIComponent(raw)).toBe(`JoinWebUrl eq '${JOIN}'`);
  });

  it("aspa simples no link é dobrada (sem quebrar/injetar no literal OData)", () => {
    const url = onlineMeetingFilterUrl("https://teams.microsoft.com/l/x' or 1 eq 1 or 'a")!;
    expect(url).toBeNull(); // espaço não é aceito num link de entrada
    const quoted = onlineMeetingFilterUrl("https://teams.microsoft.com/l/x'or'a")!;
    const raw = quoted.slice(quoted.indexOf("$filter=") + 8, quoted.indexOf("&$select"));
    expect(decodeURIComponent(raw)).toBe("JoinWebUrl eq 'https://teams.microsoft.com/l/x''or''a'");
  });

  it("recusa (null) link vazio, não-https, com espaço/controle ou acima do teto", () => {
    expect(onlineMeetingFilterUrl("")).toBeNull();
    expect(onlineMeetingFilterUrl("http://teams.microsoft.com/l/x")).toBeNull();
    expect(onlineMeetingFilterUrl("https://teams.microsoft.com/l/x\ny")).toBeNull();
    expect(onlineMeetingFilterUrl(`https://teams.microsoft.com/${"a".repeat(JOIN_URL_MAX_CHARS)}`)).toBeNull();
    expect(onlineMeetingFilterUrl("javascript:alert(1)")).toBeNull();
    // Defesa em profundidade: só hosts do Teams, sem credenciais.
    expect(onlineMeetingFilterUrl("https://evil.com/l/meetup-join/x")).toBeNull();
    expect(onlineMeetingFilterUrl("https://teams.microsoft.com.evil.com/l/x")).toBeNull();
    expect(onlineMeetingFilterUrl("https://u:p@teams.microsoft.com/l/x")).toBeNull();
    expect(onlineMeetingFilterUrl("https://Teams.Microsoft.com/l/x")).not.toBeNull();
  });
});

describe("cliente HTTP — reuniões e transcrições", () => {
  it("findOnlineMeetingByJoinUrl: GET /me/onlineMeetings com o filtro; mapeia id e organizador", async () => {
    const c = capture(() =>
      json(200, { value: [{ id: "MSo1", joinWebUrl: JOIN, participants: { organizer: { identity: { user: { id: "g-1" } } } } }] }),
    );
    const meeting = await createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).findOnlineMeetingByJoinUrl(JOIN);
    expect(meeting).toEqual({ id: "MSo1", joinWebUrl: JOIN, organizerId: "g-1" });
    expect(c.urls[0]).toBe(onlineMeetingFilterUrl(JOIN));
    expect((c.inits[0].headers as Record<string, string>).Authorization).toBe("Bearer T0");
  });

  it("link inválido não chama o Graph; lista vazia = null", async () => {
    const c = capture(() => json(200, { value: [] }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch: c.fetch });
    expect(await client.findOnlineMeetingByJoinUrl("http://x")).toBeNull();
    expect(c.urls).toHaveLength(0);
    expect(await client.findOnlineMeetingByJoinUrl(JOIN)).toBeNull();
  });

  it("transcrições e conteúdo ficam sob /me/onlineMeetings/{id}; conteúdo pede text/vtt", async () => {
    const c = capture((u) =>
      u.includes("/content")
        ? new Response("WEBVTT\n\n00:00.000 --> 00:01.000\n<v A>oi\n", { status: 200, headers: { "content-type": "text/vtt" } })
        : json(200, { value: [{ id: "T/1", createdDateTime: "2026-11-26T14:05:00Z" }, { nope: true }] }),
    );
    const client = createHttpGraphClient({ tokens: tokens(), fetch: c.fetch });
    expect(await client.listTranscripts("../x")).toEqual([{ id: "T/1", createdDateTime: "2026-11-26T14:05:00Z" }]);
    // Id com "/" e ".." fica num único segmento (nunca sai de /me/onlineMeetings/{id}).
    expect(c.urls[0]).toBe("https://graph.microsoft.com/v1.0/me/onlineMeetings/..%2Fx/transcripts");
    const vtt = await client.getTranscriptContent("MSo1", "T/1");
    expect(vtt).toContain("<v A>oi");
    expect(c.urls[1]).toBe("https://graph.microsoft.com/v1.0/me/onlineMeetings/MSo1/transcripts/T%2F1/content?$format=text/vtt");
    expect((c.inits[1].headers as Record<string, string>).Accept).toBe("text/vtt");
  });

  it("teto de bytes do VTT: content-length acima ou stream que passa → content_too_large", async () => {
    const big = capture(() => new Response("x".repeat(100), { status: 200, headers: { "content-length": "100" } }));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch: big.fetch }).getTranscriptContent("m", "t", 50)).rejects.toMatchObject({
      code: CONTENT_TOO_LARGE,
    });
    // Stream sem content-length em vários pedaços: cancela assim que passa do teto.
    let pulled = 0;
    const streamed = capture(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              if (pulled > 10) controller.close();
              else controller.enqueue(new TextEncoder().encode("y".repeat(20)));
            },
          }),
          { status: 200 },
        ),
    );
    const error = await createHttpGraphClient({ tokens: tokens(), fetch: streamed.fetch })
      .getTranscriptContent("m", "t", 50)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphError);
    expect(error).toMatchObject({ code: CONTENT_TOO_LARGE });
    // 3 pedaços de 20 bytes passam de 50: o resto nunca é lido.
    expect(pulled).toBeLessThan(6);
  });

  it("403 vira erro `forbidden` tipado (sem retry)", async () => {
    const c = capture(() => json(403, { error: { code: "Forbidden" } }));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch: c.fetch }).listTranscripts("m")).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    });
    expect(c.urls).toHaveLength(1);
  });
});
