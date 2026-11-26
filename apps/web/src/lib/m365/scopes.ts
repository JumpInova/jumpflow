/**
 * Microsoft 365 — escopos delegados por fase. PURO.
 *
 * Regra: nunca pedir escopo de fase futura; nunca `Mail.Send`, nada `ReadWrite`,
 * nada `Chat.*`, nada `.default` e nenhum `.All` (exceto
 * `OnlineMeetingTranscript.Read.All`, delegado da M3, que exige consentimento de
 * admin no tenant). A checagem é feita escopo a escopo, inclusive quando o chamador passa
 * uma string separada por espaço.
 */

/**
 * Fases (rótulos dos pedidos de consentimento). O que vale para refresh,
 * gravação e checagem é o CONJUNTO DE CAPACIDADES consentidas (agenda é a base;
 * `MAIL` e `TEAMS` são opcionais e independentes): M1, M1+e-mail, M1+Teams e
 * M1+e-mail+Teams são todos válidos — a M3 NÃO exige a M2.
 *
 * - `M1` = só a base (agenda).
 * - `M2` = base + `MAIL` (pedido "Ativar atas por e-mail").
 * - `M3` = base + `TEAMS` (pedido "Ativar transcrições do Teams").
 *
 * Um pedido incremental soma a capacidade nova às já consentidas (o connect
 * monta o conjunto); nunca pede escopo fora do conjunto.
 */
export type M365Phase = "M1" | "M2" | "M3";

/** Capacidades opcionais além da base (agenda). */
export type M365Capability = "MAIL" | "TEAMS";
export const M365_CAPABILITIES: readonly M365Capability[] = ["MAIL", "TEAMS"];

/** M1 — Conexão + Agenda. */
export const M1_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Calendars.Read",
] as const;

/** Escopos de cada capacidade opcional (só leitura, delegados). */
export const CAPABILITY_SCOPES: Record<M365Capability, readonly string[]> = {
  MAIL: ["Mail.Read"],
  // `OnlineMeetingTranscript.Read.All` é DELEGADO, mas exige consentimento de
  // admin no tenant.
  TEAMS: ["OnlineMeetings.Read", "OnlineMeetingTranscript.Read.All"],
};

/** M2 — E-mail de atas: M1 + leitura de e-mail (só leitura, nunca envio). */
export const M2_SCOPES = [...M1_SCOPES, ...CAPABILITY_SCOPES.MAIL] as const;
/** M3 — teto de tudo que a integração pode pedir (M1 + e-mail + Teams). */
export const M3_SCOPES = [...M2_SCOPES, ...CAPABILITY_SCOPES.TEAMS] as const;

/** Capacidade que cada fase acrescenta à base. */
export const PHASE_CAPABILITY: Record<M365Phase, M365Capability | null> = {
  M1: null,
  M2: "MAIL",
  M3: "TEAMS",
};

/**
 * Escopos permitidos por fase. Para validar um pedido use o conjunto de
 * capacidades ({@link scopesForCapabilities}); este mapa é o teto por rótulo
 * (M3 = tudo que existe), usado só como allowlist.
 */
export const PHASE_SCOPES: Record<M365Phase, readonly string[]> = {
  M1: M1_SCOPES,
  M2: M2_SCOPES,
  M3: M3_SCOPES,
};

/** Conjunto canônico (ordem fixa, sem duplicar) de capacidades. */
export function normalizeCapabilities(caps: Iterable<unknown>): M365Capability[] {
  const set = new Set<unknown>(caps);
  return M365_CAPABILITIES.filter((c) => set.has(c));
}

export function isCapabilityList(value: unknown): value is M365Capability[] {
  return (
    Array.isArray(value) &&
    value.length <= M365_CAPABILITIES.length &&
    value.every((c) => c === "MAIL" || c === "TEAMS")
  );
}

/** Escopos exatos de um conjunto de capacidades (base + opcionais). */
export function scopesForCapabilities(caps: readonly M365Capability[]): string[] {
  const out: string[] = [...M1_SCOPES];
  for (const cap of normalizeCapabilities(caps)) out.push(...CAPABILITY_SCOPES[cap]);
  return out;
}

/**
 * Perfil de escopo aceito pelas checagens: um rótulo de fase (teto) ou um
 * conjunto de capacidades (exato).
 */
export type ScopeProfile = M365Phase | readonly M365Capability[];

function profileScopes(profile: ScopeProfile): readonly string[] {
  return typeof profile === "string" ? PHASE_SCOPES[profile] : scopesForCapabilities(profile);
}

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
  phase: ScopeProfile,
): string[] {
  const scopes = splitScopes(requested);
  const forbidden = scopes.filter(isForbiddenScope);
  if (forbidden.length > 0) throw new ForbiddenScopeError(forbidden);
  const allowed = new Set(profileScopes(phase).map(normalizeScope));
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

/** Os escopos concedidos incluem a leitura de e-mail (M2)? */
export function hasMailScope(granted: readonly string[]): boolean {
  return splitScopes(granted)
    .map(normalizeScope)
    .includes("mail.read");
}

/** Os escopos concedidos incluem a leitura de transcrições do Teams (M3)? */
export function hasTeamsScopes(granted: readonly string[]): boolean {
  const set = new Set(splitScopes(granted).map(normalizeScope));
  return CAPABILITY_SCOPES.TEAMS.every((s) => set.has(normalizeScope(s)));
}

/**
 * Capacidades EFETIVAMENTE consentidas a partir dos escopos gravados (já
 * filtrados): `MAIL` com `Mail.Read`; `TEAMS` só com OS DOIS escopos do Teams.
 * O refresh pede exatamente os escopos deste conjunto — nunca além.
 */
export function consentedCapabilities(granted: readonly string[]): M365Capability[] {
  const caps: M365Capability[] = [];
  if (hasMailScope(granted)) caps.push("MAIL");
  if (hasTeamsScopes(granted)) caps.push("TEAMS");
  return caps;
}

/**
 * Rótulo da fase "mais alta" consentida (só para log/compatibilidade): M3 se
 * há Teams, M2 se há e-mail, senão M1. Para escopos use as capacidades.
 */
export function consentedPhase(granted: readonly string[]): M365Phase {
  if (hasTeamsScopes(granted)) return "M3";
  return hasMailScope(granted) ? "M2" : "M1";
}

export function isM365Phase(value: unknown): value is M365Phase {
  return value === "M1" || value === "M2" || value === "M3";
}

/**
 * Conjunto pedido num consentimento incremental: o que já foi consentido + a
 * capacidade da fase pedida. "Conectar" (M1) mantém o que já existe.
 */
export function requestedCapabilities(
  phase: M365Phase,
  alreadyGranted: readonly string[],
): M365Capability[] {
  const caps = consentedCapabilities(alreadyGranted);
  const extra = PHASE_CAPABILITY[phase];
  return normalizeCapabilities(extra ? [...caps, extra] : caps);
}

/**
 * Ordem de recuo do refresh quando o Entra recusa parte do consentimento
 * (`consent_required`/`invalid_scope`): o conjunto atual, depois sem Teams
 * (consentimento de admin é o mais provável de ser retirado), depois sem
 * e-mail, por fim só a base. Cada conjunto é tentado no máximo uma vez.
 */
export function refreshFallbacks(caps: readonly M365Capability[]): M365Capability[][] {
  const current = normalizeCapabilities(caps);
  const candidates: M365Capability[][] = [
    current,
    current.filter((c) => c !== "TEAMS"),
    current.filter((c) => c !== "MAIL"),
    [],
  ];
  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.join(",");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
export function phaseGrantedScopes(granted: readonly string[], phase: ScopeProfile): string[] {
  const byKey = new Map(profileScopes(phase).map((s) => [normalizeScope(s), s] as const));
  const out: string[] = [];
  for (const scope of splitScopes(granted)) {
    const canonical = byKey.get(normalizeScope(scope));
    if (canonical && !out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** Quantos escopos concedidos estão fora da fase (para log, sem nomes). */
export function countExtraScopes(granted: readonly string[], phase: ScopeProfile): number {
  const allowed = new Set(profileScopes(phase).map(normalizeScope));
  return splitScopes(granted).filter((s) => !allowed.has(normalizeScope(s))).length;
}
