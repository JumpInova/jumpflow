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

// ── M2: mensagens (só leitura, só para a ata do checkpoint) ──────────────────

export interface GraphRecipient {
  emailAddress?: GraphEmailAddress | null;
}

/** Metadados de uma mensagem (sem corpo). */
export interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  subject?: string | null;
  receivedDateTime?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  categories?: string[] | null;
  webLink?: string | null;
  hasAttachments?: boolean | null;
  isDraft?: boolean | null;
  /** Tipo derivado (ex.: `#microsoft.graph.eventMessageRequest` = convite). */
  "@odata.type"?: string | null;
}

export interface GraphMessageBody {
  /** "text" | "html" */
  contentType: "text" | "html";
  content: string;
  /** Só a parte NOVA da mensagem (sem o histórico citado), quando o Graph traz. */
  uniqueContentType: "text" | "html" | null;
  uniqueContent: string | null;
}

export interface GraphAttachmentMeta {
  id: string;
  name: string;
  contentType: string | null;
  size: number;
  isInline: boolean;
  /** Só `file` tem bytes (item/reference são ignorados). */
  kind: "file" | "item" | "reference";
}

export interface GraphAttachmentContent extends GraphAttachmentMeta {
  /** Bytes do anexo (decodificados do base64). Nunca persistidos. */
  bytes: Uint8Array;
}

// ── M3: reuniões online e transcrições do Teams (só leitura) ────────────────

/** Reunião online do PRÓPRIO usuário (`/me/onlineMeetings`). */
export interface GraphOnlineMeeting {
  id: string;
  joinWebUrl: string | null;
  /** Id (Graph) do organizador, quando o Graph informa. Só em memória. */
  organizerId: string | null;
}

/** Metadados de uma transcrição (sem conteúdo). */
export interface GraphTranscriptMeta {
  id: string;
  createdDateTime: string | null;
}
