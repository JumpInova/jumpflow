import { ALLOWED_TEAMS_JOIN_HOSTS } from "../config";
import type { GraphEvent } from "../graph/types";

/**
 * Normalização PURA de um evento do Graph para o que a M1 guarda.
 *
 * - NUNCA lê `body`/`bodyPreview` (o corpo do convite não é armazenado).
 * - Eventos privados/confidenciais/pessoais e `seriesMaster` são descartados.
 * - `joinUrl` só é mantido para host do Teams permitido (https).
 * - Datas chegam em UTC (`Prefer: outlook.timezone="UTC"`).
 */

export interface NormalizedAttendee {
  email: string;
  name: string | null;
  /** required | optional | resource */
  type: string;
  response: string | null;
}

export interface NormalizedEvent {
  graphEventId: string;
  iCalUId: string;
  subject: string | null;
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  organizerEmail: string | null;
  organizerName: string | null;
  attendees: NormalizedAttendee[];
  categories: string[];
  joinUrl: string | null;
  isCancelled: boolean;
  webLink: string | null;
  responseStatus: string | null;
}

export type NormalizeResult =
  | { kind: "event"; event: NormalizedEvent }
  | { kind: "removed"; graphEventId: string }
  | {
      kind: "skip";
      graphEventId: string;
      reason: "private" | "series_master" | "invalid";
      /** Só no `private`: organizador (para saber se é a visão dele). */
      organizerEmail?: string | null;
      /** Só no `private`: iCalUId (o organizador pode ver o evento privado pela 1ª vez). */
      iCalUId?: string | null;
    };

const DISCARDED_SENSITIVITY = new Set(["private", "confidential", "personal"]);
const MAX_SUBJECT = 500;

export function normalizeEmail(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  return email.includes("@") ? email : null;
}

export function domainOf(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

/** Interpreta `dateTime` do Graph (sem offset quando timeZone=UTC) como UTC. */
export function parseGraphUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  let v = value.trim();
  // Graph usa 7 casas decimais; Date aceita até 3.
  v = v.replace(/(\.\d{3})\d+/, "$1");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) v = `${v}Z`;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Mantém só links https de reunião do Teams em host permitido. */
export function sanitizeJoinUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    return ALLOWED_TEAMS_JOIN_HOSTS.includes(url.hostname.toLowerCase())
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** webLink do Outlook: só https em host da Microsoft. */
function sanitizeWebLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return host.endsWith(".office.com") ||
      host.endsWith(".office365.com") ||
      host.endsWith(".cloud.microsoft") ||
      host === "outlook.office.com" ||
      host === "outlook.live.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function normalizeGraphEvent(raw: GraphEvent): NormalizeResult {
  const graphEventId = typeof raw?.id === "string" ? raw.id : "";
  if (raw && raw["@removed"]) {
    return graphEventId
      ? { kind: "removed", graphEventId }
      : { kind: "skip", graphEventId: "", reason: "invalid" };
  }
  if (!graphEventId) return { kind: "skip", graphEventId: "", reason: "invalid" };
  if (DISCARDED_SENSITIVITY.has((raw.sensitivity ?? "normal").toLowerCase())) {
    return {
      kind: "skip",
      graphEventId,
      reason: "private",
      organizerEmail: normalizeEmail(raw.organizer?.emailAddress?.address),
      iCalUId: (raw.iCalUId ?? "").trim() || null,
    };
  }
  if ((raw.type ?? "").toLowerCase() === "seriesmaster") {
    return { kind: "skip", graphEventId, reason: "series_master" };
  }
  const iCalUId = (raw.iCalUId ?? "").trim();
  const startAt = parseGraphUtc(raw.start?.dateTime);
  const endAt = parseGraphUtc(raw.end?.dateTime);
  if (!iCalUId || !startAt || !endAt || endAt < startAt) {
    return { kind: "skip", graphEventId, reason: "invalid" };
  }

  const attendees: NormalizedAttendee[] = [];
  const seen = new Set<string>();
  for (const a of raw.attendees ?? []) {
    const email = normalizeEmail(a?.emailAddress?.address);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    attendees.push({
      email,
      name: a?.emailAddress?.name?.trim() || null,
      type: (a?.type ?? "required").toLowerCase(),
      response: a?.status?.response ?? null,
    });
  }

  const subject = raw.subject?.trim() ? raw.subject.trim().slice(0, MAX_SUBJECT) : null;

  return {
    kind: "event",
    event: {
      graphEventId,
      iCalUId,
      subject,
      startAt,
      endAt,
      isAllDay: Boolean(raw.isAllDay),
      organizerEmail: normalizeEmail(raw.organizer?.emailAddress?.address),
      organizerName: raw.organizer?.emailAddress?.name?.trim() || null,
      attendees,
      categories: (raw.categories ?? []).filter((c): c is string => typeof c === "string").map((c) => c.trim()).filter(Boolean),
      joinUrl: sanitizeJoinUrl(raw.onlineMeeting?.joinUrl),
      isCancelled: Boolean(raw.isCancelled),
      webLink: sanitizeWebLink(raw.webLink),
      responseStatus: raw.responseStatus?.response ?? null,
    },
  };
}
