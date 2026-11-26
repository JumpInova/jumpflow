import type { FetchLike } from "../oauth";
import { GraphError, kindForStatus } from "./errors";
import type { GraphDeltaPage, GraphEvent, GraphMe } from "./types";

/**
 * Cliente Microsoft Graph — `fetch` puro, sem SDK.
 *
 * Toda leitura do Graph passa pela interface {@link GraphClient}, injetável: os
 * testes usam `createFakeGraphClient` (./fake) e nunca falam com a Microsoft.
 *
 * - `Prefer: outlook.timezone="UTC"` em toda chamada (datas sempre em UTC).
 * - Retry em 429/503/504 respeitando `Retry-After`, com teto de tentativas, teto
 *   de espera e o prazo (`deadline`) da rodada.
 * - Timeout por chamada (AbortController).
 * - 401: força UM refresh do token e repete; persistindo → `reauth`.
 * - `nextLink`/`deltaLink` só são seguidos se apontarem para graph.microsoft.com
 *   (o token nunca vai para outro host).
 */
export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const GRAPH_HOST = "graph.microsoft.com";

export type CalendarDeltaRequest =
  | { link: string }
  | { startDateTime: string; endDateTime: string };

export interface GraphClient {
  getMe(): Promise<GraphMe>;
  calendarViewDelta(
    request: CalendarDeltaRequest,
  ): Promise<GraphDeltaPage<GraphEvent>>;
}

/** Fornece o access token; `refresh` força renovação (após 401). */
export interface AccessTokenProvider {
  get(): Promise<string>;
  refresh(): Promise<string>;
}

export interface HttpGraphClientOptions {
  tokens: AccessTokenProvider;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Epoch ms: prazo da rodada. Espera/chamada que não cabe → erro `deadline`. */
  deadline?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryAfterMs?: number;
  /** Tamanho de página pedido ao delta. */
  pageSize?: number;
}

const DEFAULTS = {
  timeoutMs: 20_000,
  maxRetries: 3,
  maxRetryAfterMs: 30_000,
  pageSize: 50,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry-After em segundos (ou data HTTP) → ms. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  return null;
}

/** Aceita só URLs https do host do Graph (defesa contra links adulterados). */
export function assertGraphUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new GraphError("http", "Link do Graph inválido.", { code: "invalid_link" });
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== GRAPH_HOST) {
    throw new GraphError("http", "Link fora do host do Graph.", { code: "invalid_link" });
  }
  return parsed.toString();
}

export function createHttpGraphClient(options: HttpGraphClientOptions): GraphClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
  const pageSize = options.pageSize ?? DEFAULTS.pageSize;

  function remaining(): number {
    return options.deadline === undefined ? Number.POSITIVE_INFINITY : options.deadline - now();
  }

  async function once(url: string, token: string): Promise<Response> {
    const budget = remaining();
    if (budget <= 0) {
      throw new GraphError("http", "Prazo da rodada esgotado.", { cause: "deadline" });
    }
    const controller = new AbortController();
    const limit = Math.min(timeoutMs, budget);
    const timer = setTimeout(() => controller.abort(), limit);
    try {
      return await doFetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Prefer: `outlook.timezone="UTC", odata.maxpagesize=${pageSize}`,
        },
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        const cause = limit < timeoutMs ? "deadline" : "timeout";
        throw new GraphError("http", "Chamada ao Graph excedeu o tempo.", { cause });
      }
      throw new GraphError("http", "Falha de rede ao chamar o Graph.", { code: "network_error" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function errorFrom(res: Response): Promise<GraphError> {
    let code: string | null = null;
    try {
      const json = (await res.json()) as { error?: { code?: string } };
      code = typeof json?.error?.code === "string" ? json.error.code : null;
    } catch {
      code = null;
    }
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now());
    return new GraphError(kindForStatus(res.status, code), `Graph respondeu ${res.status}.`, {
      status: res.status,
      code,
      retryAfterMs,
    });
  }

  async function getJson<T>(url: string): Promise<T> {
    let token = await options.tokens.get();
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const res = await once(url, token);
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw new GraphError("http", "Resposta do Graph ilegível.", {
            status: res.status,
            code: "invalid_json",
          });
        }
      }
      const error = await errorFrom(res);
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        token = await options.tokens.refresh();
        continue;
      }
      if (error.kind === "throttled" && attempt < maxRetries) {
        const wait = Math.min(error.retryAfterMs ?? 2 ** attempt * 1000, maxRetryAfterMs);
        if (wait >= remaining()) {
          throw new GraphError("throttled", "Throttling além do prazo da rodada.", {
            status: error.status,
            code: error.code,
            retryAfterMs: error.retryAfterMs,
            cause: "deadline",
          });
        }
        attempt += 1;
        await sleep(wait);
        continue;
      }
      throw error;
    }
  }

  return {
    async getMe() {
      const me = await getJson<{ id?: string; mail?: string | null; userPrincipalName?: string | null }>(
        `${GRAPH_BASE_URL}/me?$select=id,mail,userPrincipalName`,
      );
      if (!me?.id) throw new GraphError("http", "Resposta /me sem id.", { code: "invalid_me" });
      return { id: me.id, mail: me.mail ?? null, userPrincipalName: me.userPrincipalName ?? null };
    },

    async calendarViewDelta(request) {
      const url =
        "link" in request
          ? assertGraphUrl(request.link)
          : `${GRAPH_BASE_URL}/me/calendarView/delta?startDateTime=${encodeURIComponent(
              request.startDateTime,
            )}&endDateTime=${encodeURIComponent(request.endDateTime)}`;
      const json = await getJson<{
        value?: GraphEvent[];
        "@odata.nextLink"?: string;
        "@odata.deltaLink"?: string;
      }>(url);
      return {
        value: Array.isArray(json.value) ? json.value : [],
        nextLink: json["@odata.nextLink"] ?? null,
        deltaLink: json["@odata.deltaLink"] ?? null,
      };
    },
  };
}
