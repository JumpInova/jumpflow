/**
 * Microsoft 365 (M1) — configuração da integração. Só lê `process.env`.
 *
 * - Feature flag `M365_INTEGRATION_ENABLED` (desligada por padrão). Desligada,
 *   rotas, jobs, telas e server actions da integração ficam inertes.
 * - Credenciais próprias `M365_CLIENT_ID`/`M365_CLIENT_SECRET`/`M365_TENANT_ID`,
 *   com fallback para `AUTH_MICROSOFT_ENTRA_ID_*` (o mesmo app do login), mas o
 *   consentimento é SEMPRE incremental e separado do login.
 * - O tenant precisa ser específico: `common`, `organizations` e `consumers` são
 *   recusados (a integração é single-tenant, só a conta da empresa conecta).
 * - Redirect URI: `${AUTH_URL}/api/integrations/m365/callback`.
 */

export const M365_CALLBACK_PATH = "/api/integrations/m365/callback";
export const M365_CONNECT_PATH = "/api/integrations/m365/connect";
/** Tela do usuário (área de conta). */
export const M365_ACCOUNT_PATH = "/app/conta/microsoft-365";
/** Visão admin (N de M conectados). */
export const M365_ADMIN_PATH = "/app/admin/integracoes-m365";

/** Tenants multi-locatário/pessoais que NUNCA são aceitos. */
const FORBIDDEN_TENANTS = new Set(["common", "organizations", "consumers"]);

function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

/** Feature flag server-side (nunca NEXT_PUBLIC). Off por padrão. */
export function isM365Enabled(): boolean {
  return isTrue(process.env.M365_INTEGRATION_ENABLED?.trim());
}

export interface M365Credentials {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

export type M365ConfigResult =
  | { ok: true; credentials: M365Credentials }
  | { ok: false; reason: "missing_credentials" | "forbidden_tenant" };

/** Resolve as credenciais (próprias → fallback do login), validando o tenant. */
export function resolveM365Credentials(
  env: NodeJS.ProcessEnv = process.env,
): M365ConfigResult {
  const clientId =
    env.M365_CLIENT_ID?.trim() || env.AUTH_MICROSOFT_ENTRA_ID_ID?.trim() || "";
  const clientSecret =
    env.M365_CLIENT_SECRET?.trim() ||
    env.AUTH_MICROSOFT_ENTRA_ID_SECRET?.trim() ||
    "";
  const tenantId =
    env.M365_TENANT_ID?.trim() ||
    env.AUTH_MICROSOFT_ENTRA_ID_TENANT_ID?.trim() ||
    "";
  if (!clientId || !clientSecret || !tenantId) {
    return { ok: false, reason: "missing_credentials" };
  }
  if (FORBIDDEN_TENANTS.has(tenantId.toLowerCase())) {
    return { ok: false, reason: "forbidden_tenant" };
  }
  return { ok: true, credentials: { clientId, clientSecret, tenantId } };
}

/** Whether the tenant id string is one of the refused multi-tenant aliases. */
export function isForbiddenTenant(tenantId: string): boolean {
  return FORBIDDEN_TENANTS.has(tenantId.trim().toLowerCase());
}

/**
 * Base pública do app para montar o redirect URI. `AUTH_URL` (Auth.js), com
 * fallback para `NEXTAUTH_URL`. Fora de produção, sem nenhuma das duas, usa a
 * origem da requisição (conveniência local). Em produção, ausente = null
 * (erro de configuração — nunca derivar do Host enviado pelo cliente).
 */
export function resolveAppBaseUrl(
  requestOrigin: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const configured = env.AUTH_URL?.trim() || env.NEXTAUTH_URL?.trim() || "";
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return null;
    }
  }
  if (env.NODE_ENV === "production") return null;
  return requestOrigin;
}

export function buildRedirectUri(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${M365_CALLBACK_PATH}`;
}

/**
 * Domínios públicos de e-mail: nunca contam como "cliente" na sugestão de horas.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "outlook.com.br",
  "hotmail.com",
  "hotmail.com.br",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "gmx.com",
  "zoho.com",
]);

/**
 * Domínios internos (da própria empresa): `M365_INTERNAL_DOMAINS` (lista
 * separada por vírgula). O domínio da caixa conectada é somado em tempo de uso.
 */
export function configuredInternalDomains(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return (env.M365_INTERNAL_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

/** Hosts aceitos para `joinUrl` (links de reunião do Teams). */
export const ALLOWED_TEAMS_JOIN_HOSTS: readonly string[] = [
  "teams.microsoft.com",
  "teams.live.com",
  "teams.cloud.microsoft",
];
