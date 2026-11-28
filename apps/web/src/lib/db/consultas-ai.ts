/**
 * Assistente de IA de Consultas (ESPECIFICAÇÃO §6 C3) — servidor.
 *
 * - exige `CONSULTAS_IA` + `CONSULTAS_CRIAR` (a spec gerada é ad hoc);
 * - provider SEMPRE via `getAiTextProvider()` (DeepSeek → Gemini); sem
 *   provider configurado → "assistente indisponível" (o construtor segue);
 * - rate limit por usuário PERSISTIDO (tabela `ConsultaAiUsage`, contador por
 *   minuto incrementado atomicamente) — nada em memória (Railway pode ter mais
 *   de uma instância);
 * - o prompt leva só `visibleCatalog(access)`; a saída é validada pelo mesmo
 *   Zod + permissão do construtor;
 * - uso registrado em auditoria SEM o texto do usuário.
 *
 * A spec devolvida NÃO é executada aqui: o usuário confirma e ela roda pelo
 * caminho normal (`runConsulta`, origem ad hoc), que revalida tudo.
 */
import { randomUUID } from "node:crypto";
import { Prisma, prisma } from "@jumpflow/database";
import type { AppUser } from "@/lib/auth/types";
import { getAiTextProvider, getConfiguredAiModel, isAiProviderConfigured } from "@/lib/ai/provider";
import { recordAuditEvent } from "@/lib/db/audit";
import { resolveDbUser } from "@/lib/db/users";
import { getConsultaContext } from "@/lib/db/consultas";
import { visibleCatalog } from "@/lib/consultas/access";
import {
  AI_FRIENDLY,
  generateConsultaSpec,
  normalizeAiRequest,
  type AiGenerateResult,
} from "@/lib/consultas/ai";
import { ConsultaError } from "@/lib/consultas/errors";
import type { ConsultaSpec } from "@/lib/consultas/types";
import { isoDateInSaoPaulo } from "@/lib/sla/business-days";

/** Limites do assistente por usuário. */
export const AI_RATE_LIMIT = {
  perMinute: 5,
  perHour: 40,
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Contadores mais antigos que isto são apagados (limpeza oportunista). */
const RETENTION_MS = 24 * HOUR_MS;

export type AiQuota = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Início da janela de 1 minuto (UTC) que contém `now`. */
export function minuteWindow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * Consome 1 uso do assistente. Atômico entre instâncias: o contador do minuto
 * é incrementado por `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. O teto
 * por hora soma as janelas da última hora antes de incrementar.
 */
export async function consumeAiQuota(userId: string, now: Date): Promise<AiQuota> {
  const window = minuteWindow(now);
  const hourAgo = new Date(now.getTime() - HOUR_MS);

  const [{ total }] = await prisma.$queryRaw<{ total: number | bigint | null }[]>(Prisma.sql`
    SELECT COALESCE(SUM("count"), 0) AS "total"
    FROM "ConsultaAiUsage"
    WHERE "userId" = ${userId} AND "windowStart" > ${hourAgo}
  `);
  if (Number(total ?? 0) >= AI_RATE_LIMIT.perHour) {
    return { allowed: false, retryAfterSeconds: 15 * 60 };
  }

  // UPSERT CONDICIONAL: no limite do minuto o UPDATE não acontece (0 linhas
  // devolvidas) — o pedido bloqueado não consome a cota da hora.
  const rows = await prisma.$queryRaw<{ count: number }[]>(Prisma.sql`
    INSERT INTO "ConsultaAiUsage" ("id", "userId", "windowStart", "count")
    VALUES (${randomUUID()}, ${userId}, ${window}, 1)
    ON CONFLICT ("userId", "windowStart")
    DO UPDATE SET "count" = "ConsultaAiUsage"."count" + 1
    WHERE "ConsultaAiUsage"."count" < ${AI_RATE_LIMIT.perMinute}
    RETURNING "count"
  `);

  // Limpeza oportunista dos contadores antigos deste usuário (barata, indexada).
  await prisma.consultaAiUsage
    .deleteMany({ where: { userId, windowStart: { lt: new Date(now.getTime() - RETENTION_MS) } } })
    .catch(() => undefined);

  if (rows.length === 0 || Number(rows[0].count) > AI_RATE_LIMIT.perMinute) {
    const retry = Math.max(1, Math.ceil((window.getTime() + MINUTE_MS - now.getTime()) / 1000));
    return { allowed: false, retryAfterSeconds: retry };
  }
  return { allowed: true };
}

export type AssistResult =
  | { ok: true; spec: ConsultaSpec; entityLabel: string; explanation: string[] }
  | {
      ok: false;
      code: "UNAVAILABLE" | "RATE_LIMITED" | "INVALID" | "GAVE_UP" | "CANNOT_ANSWER";
      error: string;
    };

async function auditUsage(
  actorUserId: string,
  outcome: string,
  extra: Record<string, unknown>,
): Promise<void> {
  // Sem o texto do usuário (nem trecho): só o desfecho e metadados.
  await recordAuditEvent({
    actorUserId,
    entityType: "Consulta",
    entityId: "assistente-ia",
    action: "CONSULTA_IA_USADA",
    after: { outcome, model: getConfiguredAiModel(), ...extra },
  });
}

/**
 * Gera a spec a partir do pedido. Lança {@link ConsultaError} FORBIDDEN sem
 * permissão; os demais desfechos voltam como resultado (mensagens amigáveis).
 */
export async function assistConsulta(
  user: AppUser,
  rawRequest: unknown,
  now: Date = new Date(),
): Promise<AssistResult> {
  const context = await getConsultaContext(user);
  if (!context.access.ai) {
    throw new ConsultaError("FORBIDDEN", "Você não tem acesso ao assistente de IA.");
  }
  const request = normalizeAiRequest(rawRequest);
  if (!request) {
    return {
      ok: false,
      code: "INVALID",
      error: "Descreva a consulta em poucas palavras (de 3 a 500 caracteres).",
    };
  }
  if (!isAiProviderConfigured()) {
    return { ok: false, code: "UNAVAILABLE", error: AI_FRIENDLY.unavailable };
  }
  const dbUser = await resolveDbUser(user).catch(() => null);
  if (!dbUser) {
    throw new ConsultaError("FORBIDDEN", "Seu usuário não foi encontrado no JumpFlow.");
  }

  const quota = await consumeAiQuota(dbUser.id, now);
  if (!quota.allowed) {
    await auditUsage(dbUser.id, "rate_limited", {});
    const minutes = Math.ceil(quota.retryAfterSeconds / 60);
    return {
      ok: false,
      code: "RATE_LIMITED",
      error:
        quota.retryAfterSeconds < 60
          ? `Muitos pedidos ao assistente. Tente de novo em ${quota.retryAfterSeconds} segundos.`
          : `Limite de pedidos ao assistente atingido. Tente de novo em ${minutes} minutos.`,
    };
  }

  const entities = visibleCatalog(context.access);
  const result: AiGenerateResult = await generateConsultaSpec({
    provider: getAiTextProvider(),
    entities,
    access: context.access,
    request,
    today: isoDateInSaoPaulo(now),
  });

  if (result.ok) {
    await auditUsage(dbUser.id, "ok", { attempts: result.attempts, entity: result.entity.key });
    return {
      ok: true,
      spec: result.spec,
      entityLabel: result.entity.label,
      explanation: result.explanation,
    };
  }
  await auditUsage(dbUser.id, result.reason, { attempts: result.attempts });
  const code =
    result.reason === "unavailable"
      ? "UNAVAILABLE"
      : result.reason === "cannot_answer"
        ? "CANNOT_ANSWER"
        : "GAVE_UP";
  return { ok: false, code, error: result.message };
}
