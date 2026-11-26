/**
 * Formas (parciais) das respostas do Microsoft Graph usadas pela integração.
 * Só o que a M1 lê. O corpo do evento (`body`/`bodyPreview`) é ignorado de
 * propósito: nunca é lido nem armazenado.
 */

export interface GraphEmailAddress {
  name?: string | null;
  address?: string | null;
}

export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone?: string | null;
}

export interface GraphAttendee {
  type?: "required" | "optional" | "resource" | string | null;
  emailAddress?: GraphEmailAddress | null;
  status?: { response?: string | null } | null;
}

export interface GraphEvent {
  id: string;
  iCalUId?: string | null;
  subject?: string | null;
  start?: GraphDateTimeTimeZone | null;
  end?: GraphDateTimeTimeZone | null;
  isAllDay?: boolean | null;
  isCancelled?: boolean | null;
  /** normal | personal | private | confidential */
  sensitivity?: string | null;
  /** singleInstance | occurrence | exception | seriesMaster */
  type?: string | null;
  organizer?: { emailAddress?: GraphEmailAddress | null } | null;
  attendees?: GraphAttendee[] | null;
  categories?: string[] | null;
  webLink?: string | null;
  isOnlineMeeting?: boolean | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  responseStatus?: { response?: string | null } | null;
  /** Presente quando o item foi removido no delta. */
  "@removed"?: { reason?: string } | null;
}

export interface GraphDeltaPage<T> {
  value: T[];
  nextLink: string | null;
  deltaLink: string | null;
}

export interface GraphMe {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
}
