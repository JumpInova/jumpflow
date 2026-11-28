import { describe, expect, it, vi } from "vitest";
import { CONTENT_TOO_LARGE, createHttpGraphClient, onlineMeetingFilterUrl } from "./client";

/**
 * M3 — QA do cliente Graph nas reuniões online/transcrições (testador; fetch
 * mockado, nada real): encoding do filtro, throttling, 401, teto em bytes.
 */

const JOIN =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA2ZDk0YTMtZTRlYS00YjU1LWE5ZDEtYzhjNGU3MmNkZjEz%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2c%22Oid%22%3a%22550fae72-d251-43ec-868c-373732c2704f%22%7d";

const filterOf = (url: string) => decodeURIComponent(url.slice(url.indexOf("$filter=") + 8, url.indexOf("&$select")));
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

/** Stream de bytes (o Blob do jsdom não tem `.stream()`). */
function streamOf(...parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      for (const p of parts) ctrl.enqueue(typeof p === "string" ? new TextEncoder().encode(p) : p);
      ctrl.close();
    },
  });
}

function tokens() {
  return { get: vi.fn(async () => "T0"), refresh: vi.fn(async () => "T1") };
}

describe("filtro JoinWebUrl — encoding", () => {
  it("link real: %3a/%40/%7b viram %253a/%2540/%257b (codificado UMA vez); decodificar devolve o original", () => {
    const url = onlineMeetingFilterUrl(JOIN)!;
    expect(url).toContain("19%253ameeting_");
    expect(url).toContain("%2540thread.v2");
    expect(url).toContain("context%3D%257b%2522Tid%2522");
    expect(filterOf(url)).toBe(`JoinWebUrl eq '${JOIN}'`);
    expect(new URL(url).searchParams.get("$filter")).toBe(`JoinWebUrl eq '${JOIN}'`);
  });

  it("& + # = ; e aspas no link ficam dentro do literal (não viram parâmetros); '+' nunca aparece cru", () => {
    const link = "https://teams.microsoft.com/meet/123?p=a+b%2Bc&x=1;y='z'#frag";
    const url = onlineMeetingFilterUrl(link)!;
    const u = new URL(url);
    expect([...u.searchParams.keys()]).toEqual(["$filter", "$select"]);
    expect(u.searchParams.get("$filter")).toBe("JoinWebUrl eq 'https://teams.microsoft.com/meet/123?p=a+b%2Bc&x=1;y=''z''#frag'");
    expect(u.hash).toBe("");
    expect(url.slice(0, url.indexOf("&$select"))).not.toContain("+");
  });

  it("injeção OData pelo link: aspa dobrada mantém tudo num literal só", () => {
    const evil = "https://teams.microsoft.com/l/x'%20or%20JoinWebUrl%20ne%20'";
    const f = filterOf(onlineMeetingFilterUrl(evil)!);
    expect(f).toBe("JoinWebUrl eq 'https://teams.microsoft.com/l/x''%20or%20JoinWebUrl%20ne%20'''");
    // Exatamente duas aspas "de verdade" (abertura/fechamento); as demais vêm em pares.
    const unpaired = f.replace(/''/g, "").split("'").length - 1;
    expect(unpaired).toBe(2);
  });

  it("caracteres não-ASCII/controle/DEL ou link sem host https → não chama", () => {
    expect(onlineMeetingFilterUrl("https://teams.microsoft.com/l/x\u007f")).toBeNull();
    expect(onlineMeetingFilterUrl("https://teams.microsoft.com/l/x\u0000")).toBeNull();
    expect(onlineMeetingFilterUrl("https://teams.microsoft.com/l/x\ty")).toBeNull();
    expect(onlineMeetingFilterUrl("teams.microsoft.com/l/x")).toBeNull();
    expect(onlineMeetingFilterUrl("data:text/html,x")).toBeNull();
  });
});

describe("cliente HTTP — robustez", () => {
  it("429 com Retry-After na busca da reunião: espera o indicado e repete a MESMA URL", async () => {
    const urls: string[] = [];
    let n = 0;
    const fetch = vi.fn(async (u: string) => {
      urls.push(u);
      n += 1;
      return n === 1
        ? json(429, { error: { code: "TooManyRequests" } }, { "retry-after": "2" })
        : json(200, { value: [{ id: "M1", joinWebUrl: JOIN }] });
    });
    const sleep = vi.fn(async () => {});
    const meeting = await createHttpGraphClient({ tokens: tokens(), fetch, sleep }).findOnlineMeetingByJoinUrl(JOIN);
    expect(meeting).toEqual({ id: "M1", joinWebUrl: JOIN, organizerId: null });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(urls[0]).toBe(urls[1]);
  });

  it("429 persistente no conteúdo → erro `throttled` depois do teto de tentativas (sem laço infinito)", async () => {
    const fetch = vi.fn(async () => json(429, {}, { "retry-after": "1" }));
    const client = createHttpGraphClient({ tokens: tokens(), fetch, sleep: async () => {}, maxRetries: 2 });
    await expect(client.getTranscriptContent("m", "t")).rejects.toMatchObject({ kind: "throttled" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("401 → refresh UMA vez e repete; 401 de novo → reauth", async () => {
    const t = tokens();
    const auths: string[] = [];
    let n = 0;
    const fetch = vi.fn(async (_u: string, init?: RequestInit) => {
      auths.push((init!.headers as Record<string, string>).Authorization);
      n += 1;
      return n === 1 ? json(401, {}) : json(200, { value: [] });
    });
    expect(await createHttpGraphClient({ tokens: t, fetch }).listTranscripts("m")).toEqual([]);
    expect(auths).toEqual(["Bearer T0", "Bearer T1"]);
    const always = vi.fn(async () => json(401, {}));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch: always }).listTranscripts("m")).rejects.toMatchObject({ kind: "reauth" });
    expect(always).toHaveBeenCalledTimes(2);
  });

  it("404 no conteúdo → `not_found` tipado", async () => {
    const fetch = vi.fn(async () => json(404, { error: { code: "NotFound" } }));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch }).getTranscriptContent("m", "t")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("teto é em BYTES (UTF-8), não em caracteres; multibyte partido entre chunks é remontado", async () => {
    const accents = "é".repeat(30); // 30 caracteres, 60 bytes
    const big = vi.fn(async () => new Response(streamOf(accents), { status: 200 }));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch: big }).getTranscriptContent("m", "t", 50)).rejects.toMatchObject({
      code: CONTENT_TOO_LARGE,
    });
    const bytes = Buffer.from("WEBVTT olá ação", "utf8");
    const split = bytes.indexOf(0xc3) + 1; // corta no meio do "á"
    const stream = streamOf(bytes.subarray(0, split), bytes.subarray(split));
    const ok = vi.fn(async () => new Response(stream, { status: 200 }));
    expect(await createHttpGraphClient({ tokens: tokens(), fetch: ok }).getTranscriptContent("m", "t", 1000)).toBe("WEBVTT olá ação");
  });

  it("stream sem content-length que passa do teto → content_too_large (não erro de rede)", async () => {
    const fetch = vi.fn(async () => new Response(streamOf("y".repeat(40), "y".repeat(40)), { status: 200 }));
    await expect(createHttpGraphClient({ tokens: tokens(), fetch }).getTranscriptContent("m", "t", 50)).rejects.toMatchObject({
      kind: "http",
      code: CONTENT_TOO_LARGE,
    });
  });

  it("content-length mentiroso (pequeno) não engana o teto: o stream é contado", async () => {
    const fetch = vi.fn(
      async () => new Response(streamOf("z".repeat(200), "z".repeat(300)), { status: 200, headers: { "content-length": "10" } }),
    );
    await expect(createHttpGraphClient({ tokens: tokens(), fetch }).getTranscriptContent("m", "t", 100)).rejects.toMatchObject({
      code: CONTENT_TOO_LARGE,
    });
  });

  it("lista de reuniões: item sem id é ignorado; organizador ausente = null (o run decide pela caixa do evento)", async () => {
    const fetch = vi.fn(async () =>
      json(200, { value: [{ joinWebUrl: JOIN }, { id: "", joinWebUrl: JOIN }, { id: "M2", participants: { organizer: {} } }] }),
    );
    expect(await createHttpGraphClient({ tokens: tokens(), fetch }).findOnlineMeetingByJoinUrl(JOIN)).toEqual({
      id: "M2",
      joinWebUrl: null,
      organizerId: null,
    });
  });
});
