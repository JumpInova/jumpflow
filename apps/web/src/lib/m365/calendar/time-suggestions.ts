import { domainOf, type NormalizedAttendee } from "./normalize";

/**
 * Regra PURA de sugestão de horas a partir da agenda do CONSULTOR.
 *
 * Um evento vira sugestão (projeto, data, duração) quando:
 *  - já terminou, há no máximo {@link SUGGESTION_LOOKBACK_DAYS} dias;
 *  - não está cancelado, não é dia inteiro, não foi recusado pelo consultor e
 *    dura entre {@link MIN_MINUTES} e {@link MAX_MINUTES};
 *  - tem participante EXTERNO (domínio não interno e não público) que casa com
 *    um contato de cliente de projeto em que o consultor está ALOCADO.
 *
 * Vínculo e prioridade:
 *  1. EMAIL — e-mail exato do participante é contato do cliente do projeto
 *     (`Client.contactEmail` / `billingEmails`).
 *  2. DOMAIN — só se nenhum EMAIL casar: o domínio do participante é o domínio
 *     de algum contato do cliente (domínios públicos/internos nunca contam).
 * Mais de um projeto no nível vencedor → todos são devolvidos e o consultor
 * escolhe. A sugestão NUNCA lança: só pré-preenche o formulário existente.
 */

export const SUGGESTION_LOOKBACK_DAYS = 7;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 12 * 60;

export interface SuggestionAllocation {
  projectId: string;
  /** Contatos do cliente do projeto (contactEmail + billingEmails). */
  clientEmails: readonly string[];
}

export interface SuggestionEvent {
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  isCancelled: boolean;
  organizerEmail: string | null;
  attendees: readonly NormalizedAttendee[];
}

export interface SuggestionInput {
  event: SuggestionEvent;
  /** responseStatus do consultor nesse evento (sighting). */
  responseStatus: string | null;
  /** Alocações ATIVAS do consultor vigentes na data do evento. */
  allocations: readonly SuggestionAllocation[];
  internalDomains: ReadonlySet<string>;
  publicDomains: ReadonlySet<string>;
  now: Date;
  lookbackDays?: number;
}

export interface PlannedSuggestion {
  projectIds: string[];
  matchKind: "EMAIL" | "DOMAIN";
  minutes: number;
}

function isCountableDomain(
  domain: string | null,
  internal: ReadonlySet<string>,
  pub: ReadonlySet<string>,
): domain is string {
  return Boolean(domain) && !internal.has(domain!) && !pub.has(domain!);
}

/** Participantes externos (organizador + convidados, sem salas), minúsculos. */
export function externalParticipants(
  event: SuggestionEvent,
  internal: ReadonlySet<string>,
  pub: ReadonlySet<string>,
): string[] {
  const emails = new Set<string>();
  const candidates = [
    ...(event.organizerEmail ? [event.organizerEmail] : []),
    ...event.attendees.filter((a) => a.type !== "resource").map((a) => a.email),
  ];
  for (const raw of candidates) {
    const email = raw.trim().toLowerCase();
    if (isCountableDomain(domainOf(email), internal, pub)) emails.add(email);
  }
  return [...emails];
}

export function eventMinutes(event: Pick<SuggestionEvent, "startAt" | "endAt">): number {
  return Math.round((event.endAt.getTime() - event.startAt.getTime()) / 60_000);
}

export function planTimeSuggestion(input: SuggestionInput): PlannedSuggestion | null {
  const { event, now } = input;
  const lookback = (input.lookbackDays ?? SUGGESTION_LOOKBACK_DAYS) * 86_400_000;
  if (event.isCancelled || event.isAllDay) return null;
  if ((input.responseStatus ?? "").toLowerCase() === "declined") return null;
  if (event.endAt.getTime() > now.getTime()) return null;
  if (event.endAt.getTime() < now.getTime() - lookback) return null;
  const minutes = eventMinutes(event);
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) return null;

  const externals = externalParticipants(event, input.internalDomains, input.publicDomains);
  if (externals.length === 0) return null;
  const externalSet = new Set(externals);
  const externalDomains = new Set(externals.map((e) => domainOf(e)!));

  const byEmail = new Set<string>();
  const byDomain = new Set<string>();
  for (const allocation of input.allocations) {
    for (const raw of allocation.clientEmails) {
      const contact = raw.trim().toLowerCase();
      if (!contact.includes("@")) continue;
      const domain = domainOf(contact);
      if (!isCountableDomain(domain, input.internalDomains, input.publicDomains)) continue;
      if (externalSet.has(contact)) byEmail.add(allocation.projectId);
      else if (externalDomains.has(domain)) byDomain.add(allocation.projectId);
    }
  }
  if (byEmail.size > 0) {
    return { projectIds: [...byEmail].sort(), matchKind: "EMAIL", minutes };
  }
  if (byDomain.size > 0) {
    return { projectIds: [...byDomain].sort(), matchKind: "DOMAIN", minutes };
  }
  return null;
}
