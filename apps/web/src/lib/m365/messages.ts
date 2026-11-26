/**
 * Códigos de resultado do fluxo de conexão → mensagens da UI (PT-BR). A rota de
 * callback só devolve CÓDIGOS na URL; nada de detalhe técnico, token ou e-mail.
 */
export const M365_ERROR_MESSAGES = {
  disabled: "A integração com o Microsoft 365 está desligada.",
  not_configured: "A integração com o Microsoft 365 não está configurada. Avise o administrador.",
  consent_denied: "A autorização foi cancelada na Microsoft. Nada foi conectado.",
  invalid_state: "A solicitação de conexão expirou ou é inválida. Tente conectar de novo.",
  token_exchange_failed: "Não foi possível concluir a autorização com a Microsoft. Tente de novo.",
  tenant_mismatch: "Essa conta Microsoft não pertence à organização. Use a conta da empresa.",
  account_mismatch: "A conta Microsoft escolhida não é a mesma do seu login. Só é possível conectar a própria conta.",
  scope_missing: "A permissão de leitura da agenda não foi concedida.",
  forbidden_scope: "A Microsoft concedeu permissões além das necessárias. A conexão foi recusada; avise o administrador.",
  graph_unavailable: "Não foi possível consultar a sua conta na Microsoft agora. Tente de novo em instantes.",
  user_not_found: "Seu usuário não foi encontrado na plataforma.",
  mail_scope_missing:
    "A permissão de leitura de e-mail não foi concedida. A agenda continua conectada, mas as atas por e-mail ficam desligadas.",
  mail_not_allowed: "As atas por e-mail são só para quem registra checkpoints (gestores).",
} as const;

export type M365ErrorCode = keyof typeof M365_ERROR_MESSAGES;

export function isM365ErrorCode(value: unknown): value is M365ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(M365_ERROR_MESSAGES, value);
}
