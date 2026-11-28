import { NextResponse } from "next/server";
import { M365_ACCOUNT_PATH } from "./config";
import type { M365ErrorCode } from "./messages";
import { M365_OAUTH_COOKIE, M365_OAUTH_COOKIE_PATH } from "./oauth";

/**
 * Redireciona para a tela de conexão com um CÓDIGO (nunca detalhe técnico).
 *
 * `base` é a MESMA base do redirect_uri (AUTH_URL; fora de produção, a origem).
 * Nunca o Host da requisição em produção: sem base configurada, falha fechado
 * com um Location RELATIVO (o navegador resolve contra a URL que ele mesmo
 * pediu; o servidor não ecoa nenhum Host recebido).
 */
export function redirectToAccount(
  base: string | null,
  result: { ok: true; status?: "conectado" | "atas_ativadas" | "transcricoes_ativadas" } | { ok: false; code: M365ErrorCode },
): NextResponse {
  const query = new URLSearchParams(
    result.ok ? { status: result.status ?? "conectado" } : { erro: result.code },
  );
  const path = `${M365_ACCOUNT_PATH}?${query.toString()}`;
  if (!base) {
    return new NextResponse(null, { status: 303, headers: { Location: path } });
  }
  return NextResponse.redirect(new URL(path, base));
}

/**
 * Redireciona para `path` (ex.: /login) usando a MESMA base do redirect_uri
 * (AUTH_URL; fora de produção, a origem). Sem base: Location relativo — o
 * servidor nunca ecoa o Host recebido.
 */
export function redirectToPath(base: string | null, path: string): NextResponse {
  if (!base) return new NextResponse(null, { status: 303, headers: { Location: path } });
  return NextResponse.redirect(new URL(path, base));
}

export function setOAuthCookie(res: NextResponse, value: string, maxAge: number): void {
  res.cookies.set(M365_OAUTH_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: M365_OAUTH_COOKIE_PATH,
    maxAge,
  });
}

export function clearOAuthCookie(res: NextResponse): void {
  res.cookies.set(M365_OAUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: M365_OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
}
