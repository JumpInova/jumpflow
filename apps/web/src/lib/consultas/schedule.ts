/**
 * Envio agendado de Consultas (ESPECIFICAÇÃO §6 C3) — regras PURAS.
 *
 * - Frequência diária/semanal/mensal, hora LOCAL de America/Sao_Paulo. A
 *   conversão usa `Intl` (fuso nomeado), nunca um UTC−3 fixo (§9).
 * - Janela (`windowKey`) = a ocorrência agendada efetiva, `aaaa-mm-ddTHH`
 *   (data + hora em SP), em todas as frequências. `ConsultaScheduleRun` é
 *   UNIQUE por (agendamento, janela) — é a idempotência do job.
 * - Só a ocorrência MAIS RECENTE já vencida é enviada, e só se for posterior a
 *   `activeSince` (criação, reativação ou mudança de horário): nada de
 *   "enviar o atrasado" de antes do agendamento existir.
 */
import { z } from "zod";

export const SCHEDULE_TIME_ZONE = "America/Sao_Paulo";

export const SCHEDULE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type ScheduleFrequency = (typeof SCHEDULE_FREQUENCIES)[number];

export const FREQUENCY_LABELS: Record<ScheduleFrequency, string> = {
  DAILY: "Diário",
  WEEKLY: "Semanal",
  MONTHLY: "Mensal",
};

/** 1 = segunda ... 7 = domingo (ISO). */
export const WEEKDAY_LABELS: Record<number, string> = {
  1: "segunda-feira",
  2: "terça-feira",
  3: "quarta-feira",
  4: "quinta-feira",
  5: "sexta-feira",
  6: "sábado",
  7: "domingo",
};

/** Teto de destinatários por agendamento. */
export const MAX_SCHEDULE_RECIPIENTS = 50;

export interface ScheduleTiming {
  frequency: ScheduleFrequency;
  hour: number;
  weekday?: number | null;
  monthDay?: number | null;
}

/** C0/C1, DEL e separadores de linha/parágrafo Unicode. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "Identificador inválido.");

export const scheduleInputSchema = z
  .object({
    // Vai para o ASSUNTO do e-mail: sem quebra de linha/caractere de controle
    // (header injection).
    name: z
      .string()
      .trim()
      .min(1, "Informe um nome.")
      .max(120, "Nome muito longo.")
      .refine((value) => !CONTROL_CHARS.test(value), {
        message: "O nome não pode ter quebras de linha nem caracteres de controle.",
      }),
    target: z
      .object({ kind: z.enum(["view", "panel"]), id: idSchema })
      .strict(),
    frequency: z.enum(SCHEDULE_FREQUENCIES),
    hour: z.number().int().min(0).max(23),
    weekday: z.number().int().min(1).max(7).nullable().optional(),
    monthDay: z.number().int().min(1).max(31).nullable().optional(),
    recipientUserIds: z
      .array(idSchema)
      .min(1, "Escolha ao menos um destinatário.")
      .max(MAX_SCHEDULE_RECIPIENTS, `No máximo ${MAX_SCHEDULE_RECIPIENTS} destinatários.`),
    active: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.frequency === "WEEKLY" && !value.weekday) {
      ctx.addIssue({ code: "custom", message: "Escolha o dia da semana.", path: ["weekday"] });
    }
    if (value.frequency === "MONTHLY" && !value.monthDay) {
      ctx.addIssue({ code: "custom", message: "Escolha o dia do mês.", path: ["monthDay"] });
    }
    if (new Set(value.recipientUserIds).size !== value.recipientUserIds.length) {
      ctx.addIssue({ code: "custom", message: "Destinatário repetido.", path: ["recipientUserIds"] });
    }
  });

export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

/** Só os campos de horário que valem para a frequência (o resto vira null). */
export function normalizeTiming(input: ScheduleTiming): Required<ScheduleTiming> {
  return {
    frequency: input.frequency,
    hour: input.hour,
    weekday: input.frequency === "WEEKLY" ? (input.weekday ?? null) : null,
    monthDay: input.frequency === "MONTHLY" ? (input.monthDay ?? null) : null,
  };
}

/* ─────────────────────────── Fuso horário ─────────────────────────── */

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SCHEDULE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** Data/hora de parede em São Paulo de um instante. */
export function zonedParts(instant: Date): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
  };
}

/** Diferença (ms) entre o relógio de São Paulo e o UTC num instante. */
function offsetAt(instant: Date): number {
  const p = zonedParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const truncated = Math.floor(instant.getTime() / 60_000) * 60_000;
  return asUtc - truncated;
}

/** Instante de `aaaa-mm-dd` às `hour`:00 no horário de São Paulo. */
export function zonedInstant(isoDate: string, hour: number): Date {
  const [y, m, d] = isoDate.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, 0);
  let guess = wall - offsetAt(new Date(wall));
  // Segunda passada cobre mudança de offset (horário de verão) entre o chute e o alvo.
  guess = wall - offsetAt(new Date(guess));
  return new Date(guess);
}

function isoOf(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoOf(y, m, d + days);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 1 = segunda ... 7 = domingo. */
function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** O agendamento dispara neste dia (calendário de São Paulo)? */
export function firesOn(timing: ScheduleTiming, iso: string): boolean {
  if (timing.frequency === "DAILY") return true;
  if (timing.frequency === "WEEKLY") return isoWeekday(iso) === timing.weekday;
  const [y, m, d] = iso.split("-").map(Number);
  const target = Math.min(timing.monthDay ?? 1, daysInMonth(y, m));
  return d === target;
}

/**
 * Chave da janela = a OCORRÊNCIA efetiva (data + hora em SP), para qualquer
 * frequência. Mesma ocorrência → mesma chave (sem envio duplo); mudar dia/hora
 * gera uma ocorrência nova (com `activeSince` reiniciado, as já passadas
 * continuam fora), então a nova não fica "silenciada" por um envio anterior.
 */
export function windowKeyFor(timing: ScheduleTiming, iso: string): string {
  return `${iso}T${String(timing.hour).padStart(2, "0")}`;
}

export interface Occurrence {
  at: Date;
  windowKey: string;
}

/** Maior distância (dias) entre duas ocorrências: o mensal cabe em 31. */
const SCAN_DAYS = 32;

/** Ocorrência mais recente com horário ≤ `now` (null se nenhuma no alcance). */
export function latestOccurrence(timing: ScheduleTiming, now: Date): Occurrence | null {
  const p = zonedParts(now);
  const today = isoOf(p.year, p.month, p.day);
  for (let back = 0; back <= SCAN_DAYS; back++) {
    const iso = addDaysIso(today, -back);
    if (!firesOn(timing, iso)) continue;
    const at = zonedInstant(iso, timing.hour);
    if (at.getTime() <= now.getTime()) return { at, windowKey: windowKeyFor(timing, iso) };
  }
  return null;
}

/** Próxima ocorrência com horário > `now` (para exibir na tela). */
export function nextOccurrence(timing: ScheduleTiming, now: Date): Occurrence | null {
  const p = zonedParts(now);
  const today = isoOf(p.year, p.month, p.day);
  for (let ahead = 0; ahead <= SCAN_DAYS; ahead++) {
    const iso = addDaysIso(today, ahead);
    if (!firesOn(timing, iso)) continue;
    const at = zonedInstant(iso, timing.hour);
    if (at.getTime() > now.getTime()) return { at, windowKey: windowKeyFor(timing, iso) };
  }
  return null;
}

/**
 * Janela devida agora: a ocorrência mais recente já vencida, desde que não
 * seja anterior a `activeSince`. null = nada a enviar.
 */
export function dueOccurrence(
  timing: ScheduleTiming,
  activeSince: Date,
  now: Date,
): Occurrence | null {
  const latest = latestOccurrence(timing, now);
  if (!latest) return null;
  if (latest.at.getTime() < activeSince.getTime()) return null;
  return latest;
}

/** Texto PT-BR do horário: "Diário às 08:00", "Toda segunda-feira às 08:00"... */
export function describeTiming(timing: ScheduleTiming): string {
  const time = `${String(timing.hour).padStart(2, "0")}:00`;
  if (timing.frequency === "DAILY") return `Todos os dias às ${time}`;
  if (timing.frequency === "WEEKLY") {
    const day = WEEKDAY_LABELS[timing.weekday ?? 1];
    const article = timing.weekday === 6 || timing.weekday === 7 ? "Todo" : "Toda";
    return `${article} ${day} às ${time}`;
  }
  const day = timing.monthDay ?? 1;
  return `Todo dia ${day} às ${time}${day > 28 ? " (ou o último dia do mês)" : ""}`;
}

/** Motivos de destinatário pulado (registrados no run, sem dados). */
export const SKIP_REASONS = {
  usuario_inativo: "Usuário inexistente ou inativo",
  sem_acesso_consultas: "Sem acesso a Consultas",
  sem_permissao_exportar: "Sem permissão de exportar",
  sem_acesso_visao: "Sem acesso à visão (compartilhamento ou entidade)",
  campo_sem_permissao: "A visão usa campos que o perfil não pode ver",
  sem_acesso_painel: "Sem acesso ao painel",
  nenhuma_visao_acessivel: "Nenhuma visão do painel acessível",
  alvo_excluido: "Visão ou painel excluído",
  criador_sem_permissao: "Criador inativo ou sem permissão de agendar (envio suspenso)",
} as const;

export type SkipReason = keyof typeof SKIP_REASONS;

export type RecipientOutcome =
  | { userId: string; status: "SENT"; sheets: number; hiddenViews?: number }
  | { userId: string; status: "SKIPPED"; reason: SkipReason }
  | { userId: string; status: "FAILED"; error: string };

/**
 * Status consolidado da execução:
 * - FAILED: ao menos uma falha de ENTREGA/geração (retentável; quem já
 *   recebeu fica registrado e não recebe de novo);
 * - SENT: todos receberam; PARTIAL: parte recebeu e parte foi pulada por
 *   permissão; SKIPPED: todos pulados. Esses três são finais.
 */
export function runStatus(outcomes: readonly RecipientOutcome[]): "SENT" | "PARTIAL" | "SKIPPED" | "FAILED" {
  const sent = outcomes.filter((o) => o.status === "SENT").length;
  const failed = outcomes.filter((o) => o.status === "FAILED").length;
  if (failed > 0) return "FAILED";
  if (sent === 0) return "SKIPPED";
  return outcomes.length === sent ? "SENT" : "PARTIAL";
}
