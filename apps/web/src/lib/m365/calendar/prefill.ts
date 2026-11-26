import { localClock, localIsoDate } from "./time";

/**
 * Pré-preenchimento PURO do formulário de lançamento a partir de uma sugestão
 * da agenda. Só preenche: projeto (escolhido pelo consultor entre os
 * candidatos), data e horário local; o consultor revisa, ajusta e envia — a
 * sugestão nunca lança sozinha. Projeto fora dos candidatos/permitidos = null.
 */

export interface SuggestionForPrefill {
  startAt: Date;
  endAt: Date;
  projectIds: readonly string[];
  subject: string | null;
}

export interface SuggestionPrefill {
  projectId: string;
  date: string;
  clock: {
    startTime: string;
    endTime: string;
    breakStart: string;
    breakEnd: string;
    hasBreak: boolean;
  };
  description: string;
}

const MAX_DESCRIPTION = 200;

export function buildSuggestionPrefill(
  suggestion: SuggestionForPrefill,
  projectId: string | null,
  allowedProjectIds: ReadonlySet<string>,
): SuggestionPrefill | null {
  const candidates = suggestion.projectIds.filter((id) => allowedProjectIds.has(id));
  const chosen = projectId ?? (candidates.length === 1 ? candidates[0] : null);
  if (!chosen || !candidates.includes(chosen)) return null;
  const date = localIsoDate(suggestion.startAt);
  const sameDay = localIsoDate(suggestion.endAt) === date;
  const subject = suggestion.subject?.trim();
  return {
    projectId: chosen,
    date,
    clock: {
      startTime: localClock(suggestion.startAt),
      endTime: sameDay ? localClock(suggestion.endAt) : "23:59",
      breakStart: "",
      breakEnd: "",
      hasBreak: false,
    },
    description: subject ? `Reunião: ${subject}`.slice(0, MAX_DESCRIPTION) : "Reunião",
  };
}
