import type { FetchLike } from "../oauth";
import { GraphError, kindForStatus } from "./errors";
import type {
  GraphAttachmentContent,
  GraphAttachmentMeta,
  GraphDeltaPage,
  GraphEvent,
  GraphMe,
  GraphMessage,
  GraphMessageBody,
} from "./types";

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

/**
 * M2 — busca ESTREITA de mensagens na caixa do próprio usuário (gestor). Nunca
 * lista a caixa inteira: ou filtra pela categoria (`category`), ou procura pelo
 * assunto (`subject`). A janela (`since`/`until`) é reaplicada localmente.
 */
export type MessageQuery =
  | { kind: "category"; category: string; since: string; until: string }
  | { kind: "subject"; subject: string; since: string; until: string };

export interface GraphClient {
  getMe(): Promise<GraphMe>;
  calendarViewDelta(
    request: CalendarDeltaRequest,
  ): Promise<GraphDeltaPage<GraphEvent>>;
  /** M2: metadados (sem corpo) das mensagens que casam a consulta. */
  findMessages(query: MessageQuery): Promise<GraphMessage[]>;
  /** M2: metadados de UMA mensagem (para a escolha manual do gestor). */
  getMessage(messageId: string): Promise<GraphMessage>;
  /** M2: corpo da mensagem escolhida (texto preferido; só em memória). */
  getMessageBody(messageId: string): Promise<GraphMessageBody>;
  listAttachments(messageId: string): Promise<GraphAttachmentMeta[]>;
  getAttachment(messageId: string, attachmentId: string): Promise<GraphAttachmentContent>;
}

/** Campos lidos de uma mensagem na busca (nunca body/bodyPreview). */
export const MESSAGE_SELECT =
  "id,internetMessageId,subject,receivedDateTime,from,toRecipients,ccRecipients,categories,webLink,hasAttachments,isDraft";
/** Teto de mensagens lidas por consulta (busca estreita). */
export const MESSAGE_QUERY_LIMIT = 25;
/** Teto do corpo aceito (caracteres). */
export const MESSAGE_BODY_MAX_CHARS = 512 * 1024;

/**
 * Id como UM segmento de caminho. `encodeURIComponent` não escapa ".", e o
 * parser de URL normaliza "." e ".." (inclusive "%2E%2E") como segmentos de
 * ponto: esses ids viram um literal inofensivo (o Graph devolve 404), nunca
 * saem de `/me/messages/{id}`. A action também valida o formato antes.
 */
export function pathSegment(id: string): string {
  const encoded = encodeURIComponent(id);
  return /^\.{1,2}$/.test(id) ? encoded.replace(/\./g, "%252E") : encoded;
}

/** Escapa aspas simples para literal OData. */
export function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * KQL do `$search` por assunto: só letras/dígitos/espaço (o resto vira espaço),
 * entre aspas duplas. Pendência de validação real: tokenização do Exchange.
 */
export function subjectSearchTerm(subject: string): string {
  const clean = subject
    .slice(0, 1000)
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return `"subject:${clean}"`;
}

function buildMessageQueryUrl(query: MessageQuery): string {
  const url = new URL(`${GRAPH_BASE_URL}/me/messages`);
  url.searchParams.set("$select", MESSAGE_SELECT);
  url.searchParams.set("$top", String(MESSAGE_QUERY_LIMIT));
  if (query.kind === "category") {
    url.searchParams.set(
      "$filter",
      `categories/any(c:c eq ${odataString(query.category)}) and receivedDateTime ge ${query.since} and receivedDateTime le ${query.until}`,
    );
  } else {
    // $search não combina com $filter em mensagens: a janela e os participantes
    // são reaplicados localmente (seleção pura).
    url.searchParams.set("$search", subjectSearchTerm(query.subject));
  }
  return url.toString();
}

function bodyType(value: unknown): "text" | "html" {
  return String(value ?? "").toLowerCase() === "html" ? "html" : "text";
}

function attachmentKind(odataType: unknown): GraphAttachmentMeta["kind"] {
  const t = String(odataType ?? "").toLowerCase();
  if (t.endsWith("itemattachment")) return "item";
  if (t.endsWith("referenceattachment")) return "reference";
  return "file";
}

function mapAttachmentMeta(a: Record<string, unknown>): GraphAttachmentMeta {
  const size = Number(a?.size);
  return {
    id: typeof a?.id === "string" ? a.id : "",
    name: typeof a?.name === "string" && a.name ? a.name : "anexo",
    contentType: typeof a?.contentType === "string" && a.contentType ? a.contentType : null,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    isInline: Boolean(a?.isInline),
    kind: attachmentKind(a?.["@odata.type"]),
  };
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

  async function once(url: string, token: string, extraPrefer?: string): Promise<Response> {
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
          Prefer: `outlook.timezone="UTC", odata.maxpagesize=${pageSize}${extraPrefer ? `, ${extraPrefer}` : ""}`,
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

  async function getJson<T>(url: string, extraPrefer?: string): Promise<T> {
    let token = await options.tokens.get();
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const res = await once(url, token, extraPrefer);
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

    async findMessages(query) {
      const json = await getJson<{ value?: GraphMessage[] }>(buildMessageQueryUrl(query));
      const value = Array.isArray(json.value) ? json.value : [];
      return value.filter((m) => typeof m?.id === "string" && m.id).slice(0, MESSAGE_QUERY_LIMIT);
    },

    async getMessage(messageId) {
      const json = await getJson<GraphMessage>(
        `${GRAPH_BASE_URL}/me/messages/${pathSegment(messageId)}?$select=${MESSAGE_SELECT}`,
      );
      if (!json?.id) throw new GraphError("not_found", "Mensagem sem id.", { code: "invalid_message" });
      return json;
    },

    async getMessageBody(messageId) {
      // Corpo em TEXTO (o Graph converte); uniqueBody = só a parte nova.
      const json = await getJson<{
        body?: { contentType?: string; content?: string } | null;
        uniqueBody?: { contentType?: string; content?: string } | null;
      }>(
        `${GRAPH_BASE_URL}/me/messages/${pathSegment(messageId)}?$select=body,uniqueBody`,
        'outlook.body-content-type="text"',
      );
      const unique = json?.uniqueBody && typeof json.uniqueBody.content === "string" ? json.uniqueBody : null;
      return {
        contentType: bodyType(json?.body?.contentType),
        content:
          typeof json?.body?.content === "string" ? json.body.content.slice(0, MESSAGE_BODY_MAX_CHARS) : "",
        uniqueContentType: unique ? bodyType(unique.contentType) : null,
        uniqueContent: unique ? String(unique.content).slice(0, MESSAGE_BODY_MAX_CHARS) : null,
      };
    },

    async listAttachments(messageId) {
      const json = await getJson<{ value?: Record<string, unknown>[] }>(
        `${GRAPH_BASE_URL}/me/messages/${pathSegment(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
      );
      const value = Array.isArray(json.value) ? json.value : [];
      return value.map(mapAttachmentMeta).filter((a) => a.id);
    },

    async getAttachment(messageId, attachmentId) {
      const json = await getJson<Record<string, unknown>>(
        `${GRAPH_BASE_URL}/me/messages/${pathSegment(messageId)}/attachments/${pathSegment(attachmentId)}`,
      );
      const meta = mapAttachmentMeta(json);
      const b64 = typeof json?.contentBytes === "string" ? json.contentBytes : "";
      return { ...meta, bytes: new Uint8Array(Buffer.from(b64, "base64")) };
    },
  };
}
