/**
 * Microsoft 365 — escopos delegados por fase. PURO.
 *
 * Regra: nunca pedir escopo de fase futura; nunca `Mail.Send`, nada `ReadWrite`,
 * nada `Chat.*`, nada `.default` e nenhum `.All` (exceto
 * `OnlineMeetingTranscript.Read.All`, delegado da M3, que exige consentimento de
 * admin). A checagem é feita escopo a escopo, inclusive quando o chamador passa
 * uma string separada por espaço.
 */

export type M365Phase = "M1";

/** M1 — Conexão + Agenda. */
export const M1_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Calendars.Read",
] as const;

/** Escopos permitidos por fase (apenas M1 nesta entrega). */
export const PHASE_SCOPES: Record<M365Phase, readonly string[]> = {
  M1: M1_SCOPES,
};

/** `.All` delegados explicitamente aceitos (fases futuras). */
const ALLOWED_ALL_SCOPES = new Set(["onlinemeetingtranscript.read.all"]);

const GRAPH_RESOURCE_PREFIX = "https://graph.microsoft.com/";

/** Normaliza um escopo: sem prefixo do recurso Graph, minúsculo. */
export function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  const bare = trimmed.toLowerCase().startsWith(GRAPH_RESOURCE_PREFIX)
    ? trimmed.slice(GRAPH_RESOURCE_PREFIX.length)
    : trimmed;
  return bare.toLowerCase();
}

/** Quebra uma lista (array e/ou strings com espaços) em escopos individuais. */
export function splitScopes(input: string | readonly string[]): string[] {
  const parts = typeof input === "string" ? [input] : [...input];
  return parts
    .flatMap((part) => part.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Escopo proibido em QUALQUER fase. */
export function isForbiddenScope(scope: string): boolean {
  const s = normalizeScope(scope);
  if (!s) return false;
  if (s === ".default" || s.endsWith("/.default")) return true;
  if (s.startsWith("mail.send")) return true;
  if (s.startsWith("mail.readwrite")) return true;
  // Qualquer Chat* (Chat.*, ChatMessage.*, ChatMember.* ...).
  if (s.startsWith("chat")) return true;
  if (s.includes("readwrite")) return true;
  if (s.endsWith(".all") && !ALLOWED_ALL_SCOPES.has(s)) return true;
  return false;
}

export class ForbiddenScopeError extends Error {
  readonly scopes: string[];
  constructor(scopes: string[]) {
    super(`Escopo(s) recusado(s): ${scopes.join(", ")}`);
    this.name = "ForbiddenScopeError";
    this.scopes = scopes;
  }
}

/**
 * Valida os escopos pedidos para a fase: recusa proibidos e qualquer escopo fora
 * da lista da fase. Devolve a lista normalizada (ordem original, sem duplicar).
 */
export function assertScopesForPhase(
  requested: string | readonly string[],
  phase: M365Phase,
): string[] {
  const scopes = splitScopes(requested);
  const forbidden = scopes.filter(isForbiddenScope);
  if (forbidden.length > 0) throw new ForbiddenScopeError(forbidden);
  const allowed = new Set(PHASE_SCOPES[phase].map(normalizeScope));
  const outside = scopes.filter((s) => !allowed.has(normalizeScope(s)));
  if (outside.length > 0) throw new ForbiddenScopeError(outside);
  const seen = new Set<string>();
  return scopes.filter((s) => {
    const key = normalizeScope(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Escopos concedidos contêm algum proibido? (app registration mal configurado). */
export function grantedForbiddenScopes(granted: readonly string[]): string[] {
  return splitScopes(granted).filter(isForbiddenScope);
}

/** Os escopos concedidos cobrem o necessário para ler a agenda? */
export function hasCalendarScope(granted: readonly string[]): boolean {
  return splitScopes(granted)
    .map(normalizeScope)
    .includes("calendars.read");
}

/**
 * Só os escopos concedidos que pertencem à fase (normalizados para a grafia da
 * fase). Escopos extras permitidos (consentidos antes, fora da fase) NÃO são
 * gravados em `scopes` — só contados no IntegrationEvent pelo callback.
 */
export function phaseGrantedScopes(granted: readonly string[], phase: M365Phase): string[] {
  const byKey = new Map(PHASE_SCOPES[phase].map((s) => [normalizeScope(s), s] as const));
  const out: string[] = [];
  for (const scope of splitScopes(granted)) {
    const canonical = byKey.get(normalizeScope(scope));
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** Quantos escopos concedidos estão fora da fase (para log, sem nomes). */
export function countExtraScopes(granted: readonly string[], phase: M365Phase): number {
  const allowed = new Set(PHASE_SCOPES[phase].map(normalizeScope));
  return splitScopes(granted).filter((s) => !allowed.has(normalizeScope(s))).length;
}
