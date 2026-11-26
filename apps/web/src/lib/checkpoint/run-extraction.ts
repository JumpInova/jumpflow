import { prisma } from "@jumpflow/database";
import { getAiTextProvider, type AiTextProvider } from "@/lib/ai/provider";
import { recordAiUsage } from "@/lib/ai/log";
import { recordAuditEvent } from "@/lib/db/audit";
import { emptyPiiMap, maskPii, unmaskDeep, type PiiMap } from "@/lib/m365/minutes/pii";
import { normalizeCardText } from "./action-items";
import { isCheckpointAiEnabled } from "./flags";
import {
  CHECKPOINT_EXTRACTION_MODEL,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionPrompt,
  mapExtraction,
  parseExtraction,
  resolveExtractionBody,
} from "./extraction";

/**
 * Núcleo do pipeline de extração de insights de um Checkpoint (Melhoria #4, F4),
 * SEM autorização: quem chama já autorizou. Usado pela server action
 * `extractCheckpointInsights` (gestor clica) e pelo job de atas do Microsoft 365
 * (M2: a ata recém-gravada dispara a extração). Mesmo comportamento da F4:
 *
 * - flag F4 off ou provider noop → `unavailable` (nada muda, nada é inventado);
 * - parse inválido → extractionStatus FAILED;
 * - sucesso → descarta PENDING aiGenerated deste checkpoint e recria
 *   Oportunidades/Cases PENDING + upsert de SkillSuggestion; DONE.
 * Auditoria só com contagens (nunca o corpo).
 *
 * Privacidade: a IA só recebe texto MASCARADO (e-mail, telefone, CPF, CNPJ). Os
 * candidatos devolvidos são desmascarados em memória com o mapa da mesma
 * execução antes de gravar. Quem já tem o texto mascarado e o mapa (atas do
 * Microsoft 365) passa `masked`; senão o corpo é mascarado aqui com um mapa
 * novo de prefixo próprio (marcadores de outra execução, que não têm mapa,
 * ficam como estão).
 */

export interface ExtractionRow {
  id: string;
  consultantId: string;
  relatedProjectId: string | null;
  type: "ONE_ON_ONE" | "CHECKPOINT";
  occurredAt: Date;
  weekStart: Date | null;
  weekEnd: Date | null;
  notes: string | null;
  transcription: string | null;
}

export type ExtractionRunResult =
  | { status: "unavailable" }
  | { status: "failed"; reason: string }
  | { status: "done"; skills: number; opportunities: number; cases: number };

/**
 * Janela semanal válida para a SkillSuggestion (weekStart/weekEnd obrigatórios):
 * a do checkpoint, senão a semana (segunda→domingo, UTC) de `occurredAt`.
 */
export function resolveSkillWindow(row: {
  weekStart: Date | null;
  weekEnd: Date | null;
  occurredAt: Date;
}): { weekStart: Date; weekEnd: Date } {
  if (row.weekStart && row.weekEnd) {
    return { weekStart: row.weekStart, weekEnd: row.weekEnd };
  }
  const base = new Date(row.occurredAt);
  const day = base.getUTCDay(); // 0=domingo
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  return { weekStart, weekEnd };
}

function uniqueByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const key = normalizeCardText(i.title);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function runCheckpointExtraction(
  row: ExtractionRow,
  options: {
    actorUserId: string | null;
    provider?: AiTextProvider;
    masked?: { notes: string | null; transcription: string | null; piiMap: PiiMap };
    /**
     * Reextração automática (atas do Microsoft 365, inclusive o complemento da
     * transcrição do Teams): não recria Oportunidade/Case cujo título já foi
     * DECIDIDO (ACCEPTED/DISMISSED) neste checkpoint, nem reabre SkillSuggestion
     * já decidida. Os PENDING continuam sendo substituídos (sem duplicar). O
     * "Reprocessar" manual da F4 mantém o comportamento original.
     */
    preserveDecided?: boolean;
  },
): Promise<ExtractionRunResult> {
  const checkpointId = row.id;
  if (!isCheckpointAiEnabled()) return { status: "unavailable" };
  let piiMap: PiiMap;
  let notes: string | null;
  let transcription: string | null;
  if (options.masked) {
    ({ piiMap, notes, transcription } = options.masked);
  } else {
    piiMap = emptyPiiMap("X");
    notes = row.notes ? maskPii(row.notes, piiMap).masked : row.notes;
    transcription = row.transcription ? maskPii(row.transcription, piiMap).masked : row.transcription;
  }
  const body = resolveExtractionBody({ transcription, notes });
  if (!body.trim()) return { status: "unavailable" };

  const provider = options.provider ?? getAiTextProvider();
  const prompt = buildExtractionPrompt({ transcription, notes, type: row.type });
  const raw = await provider.complete(prompt, {
    model: CHECKPOINT_EXTRACTION_MODEL,
    system: EXTRACTION_SYSTEM_PROMPT,
    maxTokens: 1500,
    entityType: "Checkpoint",
    entityId: checkpointId,
  });
  if (raw === null) return { status: "unavailable" };

  const parsed = parseExtraction(raw);
  if (!parsed.ok) {
    await prisma.checkpoint.update({
      where: { id: checkpointId },
      data: { extractionStatus: "FAILED" },
    });
    await recordAiUsage({
      feature: "CHECKPOINT_EXTRACTION",
      model: CHECKPOINT_EXTRACTION_MODEL,
      entityType: "Checkpoint",
      entityId: checkpointId,
      status: "FAILED",
      error: parsed.reason,
    });
    await recordAuditEvent({
      actorUserId: options.actorUserId,
      entityType: "Checkpoint",
      entityId: checkpointId,
      action: "CHECKPOINT_EXTRACTION_FAILED",
      before: null,
      after: { reason: parsed.reason },
    });
    return { status: "failed", reason: parsed.reason };
  }

  const { weekStart, weekEnd } = resolveSkillWindow(row);
  // Desmascara em memória antes de gravar (títulos, descrições, trechos).
  const mapped = mapExtraction(unmaskDeep(parsed.data, piiMap), {
    checkpointId,
    consultantId: row.consultantId,
    weekStart,
    weekEnd,
    relatedProjectId: row.relatedProjectId,
  });

  const counts = { skills: mapped.skills.length, opportunities: mapped.opportunities.length, cases: mapped.cases.length };
  await prisma.$transaction(async (tx) => {
    if (options.preserveDecided) {
      const [decidedOpps, decidedCases, decidedSkills] = await Promise.all([
        tx.opportunity.findMany({
          where: { sourceCheckpointId: checkpointId, status: { not: "PENDING" } },
          select: { title: true },
        }),
        tx.case.findMany({
          where: { sourceCheckpointId: checkpointId, status: { not: "PENDING" } },
          select: { title: true },
        }),
        mapped.skills.length > 0
          ? tx.skillSuggestion.findMany({
              where: {
                consultantId: row.consultantId,
                weekStart,
                suggestedName: { in: mapped.skills.map((s) => s.suggestedName) },
                status: { not: "PENDING" },
              },
              select: { suggestedName: true },
            })
          : Promise.resolve([] as Array<{ suggestedName: string }>),
      ]);
      const opp = new Set(decidedOpps.map((o) => normalizeCardText(o.title)));
      const cas = new Set(decidedCases.map((c) => normalizeCardText(c.title)));
      const skl = new Set(decidedSkills.map((k) => k.suggestedName));
      mapped.opportunities = mapped.opportunities.filter((o) => !opp.has(normalizeCardText(o.title)));
      mapped.cases = mapped.cases.filter((c) => !cas.has(normalizeCardText(c.title)));
      mapped.skills = mapped.skills.filter((k) => !skl.has(k.suggestedName));
      // Sem duplicar dentro do próprio lote (mesmo título normalizado).
      mapped.opportunities = uniqueByTitle(mapped.opportunities);
      mapped.cases = uniqueByTitle(mapped.cases);
    }
    counts.skills = mapped.skills.length;
    counts.opportunities = mapped.opportunities.length;
    counts.cases = mapped.cases.length;
    // Idempotência: descarta candidatos PENDING aiGenerated DESTE checkpoint.
    await tx.opportunity.deleteMany({
      where: { sourceCheckpointId: checkpointId, aiGenerated: true, status: "PENDING" },
    });
    await tx.case.deleteMany({
      where: { sourceCheckpointId: checkpointId, aiGenerated: true, status: "PENDING" },
    });
    for (const s of mapped.skills) {
      await tx.skillSuggestion.upsert({
        where: {
          consultantId_weekStart_suggestedName: {
            consultantId: s.consultantId,
            weekStart: s.weekStart,
            suggestedName: s.suggestedName,
          },
        },
        update: {
          suggestedCategory: s.suggestedCategory,
          suggestedLevel: s.suggestedLevel,
          evidenceSummary: s.evidenceSummary,
          sourceEntryIds: s.sourceEntryIds,
          status: "PENDING",
          decidedAt: null,
        },
        create: {
          consultantId: s.consultantId,
          weekStart: s.weekStart,
          weekEnd: s.weekEnd,
          suggestedName: s.suggestedName,
          suggestedCategory: s.suggestedCategory,
          suggestedLevel: s.suggestedLevel,
          evidenceSummary: s.evidenceSummary,
          sourceEntryIds: s.sourceEntryIds,
        },
      });
    }
    for (const o of mapped.opportunities) {
      await tx.opportunity.create({
        data: {
          sourceCheckpointId: o.sourceCheckpointId,
          consultantId: o.consultantId,
          relatedProjectId: o.relatedProjectId,
          kind: o.kind,
          title: o.title,
          description: o.description,
          priority: o.priority,
          sourceQuote: o.sourceQuote,
          aiGenerated: true,
          status: "PENDING",
        },
      });
    }
    for (const c of mapped.cases) {
      await tx.case.create({
        data: {
          sourceCheckpointId: c.sourceCheckpointId,
          consultantId: c.consultantId,
          relatedProjectId: c.relatedProjectId,
          title: c.title,
          summary: c.summary,
          outcome: c.outcome,
          sourceQuote: c.sourceQuote,
          aiGenerated: true,
          status: "PENDING",
        },
      });
    }
    await tx.checkpoint.update({
      where: { id: checkpointId },
      data: { extractionStatus: "DONE", extractedAt: new Date() },
    });
  });

  await recordAiUsage({
    feature: "CHECKPOINT_EXTRACTION",
    model: CHECKPOINT_EXTRACTION_MODEL,
    entityType: "Checkpoint",
    entityId: checkpointId,
    status: "SUCCESS",
  });
  await recordAuditEvent({
    actorUserId: options.actorUserId,
    entityType: "Checkpoint",
    entityId: checkpointId,
    action: "CHECKPOINT_EXTRACTED",
    before: null,
    after: counts,
  });
  return { status: "done", ...counts };
}
