export interface SaleRateRange {
  id?: string;
  projectId: string;
  consultantId?: string | null;
  allocationId?: string | null;
  startsAt: string;
  endsAt?: string | null;
  hourlyRate: number;
}

export interface RateResolutionContext {
  date: string;
  consultantId?: string | null;
  allocationId?: string | null;
  projectFallbackRate?: number | null;
  clientFallbackRate?: number | null;
}

export interface ResolvedSaleRate {
  hourlyRate: number;
  source: "ALLOCATION" | "CONSULTANT" | "PROJECT" | "PROJECT_FALLBACK" | "CLIENT_FALLBACK";
  rateId?: string;
}

export function saleRateScopeKey(
  rate: Pick<SaleRateRange, "projectId" | "consultantId" | "allocationId">,
): string {
  if (rate.allocationId) return `allocation:${rate.allocationId}`;
  if (rate.consultantId) {
    return `project:${rate.projectId}:consultant:${rate.consultantId}`;
  }
  return `project:${rate.projectId}`;
}

function toTime(date: string | null | undefined): number {
  if (!date) return Number.POSITIVE_INFINITY;
  return Date.parse(date);
}

export function rangesOverlap(
  left: Pick<SaleRateRange, "startsAt" | "endsAt">,
  right: Pick<SaleRateRange, "startsAt" | "endsAt">,
): boolean {
  const leftStart = Date.parse(left.startsAt);
  const rightStart = Date.parse(right.startsAt);
  const leftEnd = toTime(left.endsAt);
  const rightEnd = toTime(right.endsAt);
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function findOverlappingSaleRate(
  existing: SaleRateRange[],
  candidate: SaleRateRange,
): SaleRateRange | undefined {
  const key = saleRateScopeKey(candidate);
  return existing.find((rate) => {
    if (rate.id && candidate.id && rate.id === candidate.id) return false;
    return saleRateScopeKey(rate) === key && rangesOverlap(rate, candidate);
  });
}

function isActiveOn(rate: SaleRateRange, date: string): boolean {
  const target = Date.parse(date);
  return Date.parse(rate.startsAt) <= target && target < toTime(rate.endsAt);
}

/**
 * Mais recente primeiro (por dia de início). Empate no mesmo dia — só ocorre
 * com faixas sobrepostas, que `findOverlappingSaleRate` bloqueia na escrita,
 * mas pode existir em dados legados — é decidido pelo maior `id` em ordem de
 * code unit (= `COLLATE "C"` no Postgres), para o resultado não depender da
 * ordem de leitura e bater com as views de Consultas (consulta_horas).
 */
function newestFirst(left: SaleRateRange, right: SaleRateRange): number {
  const byDate = Date.parse(right.startsAt) - Date.parse(left.startsAt);
  if (byDate !== 0) return byDate;
  const l = left.id ?? "";
  const r = right.id ?? "";
  return l === r ? 0 : l < r ? 1 : -1;
}

export function resolveSaleRate(
  rates: SaleRateRange[],
  context: RateResolutionContext,
): ResolvedSaleRate | null {
  const active = rates.filter((rate) => isActiveOn(rate, context.date));
  const byAllocation = context.allocationId
    ? active
        .filter((rate) => rate.allocationId === context.allocationId)
        .sort(newestFirst)[0]
    : undefined;
  if (byAllocation) {
    return {
      hourlyRate: byAllocation.hourlyRate,
      source: "ALLOCATION",
      rateId: byAllocation.id,
    };
  }

  const byConsultant = context.consultantId
    ? active
        .filter(
          (rate) =>
            !rate.allocationId && rate.consultantId === context.consultantId,
        )
        .sort(newestFirst)[0]
    : undefined;
  if (byConsultant) {
    return {
      hourlyRate: byConsultant.hourlyRate,
      source: "CONSULTANT",
      rateId: byConsultant.id,
    };
  }

  const byProject = active
    .filter((rate) => !rate.allocationId && !rate.consultantId)
    .sort(newestFirst)[0];
  if (byProject) {
    return {
      hourlyRate: byProject.hourlyRate,
      source: "PROJECT",
      rateId: byProject.id,
    };
  }

  if (context.projectFallbackRate != null) {
    return {
      hourlyRate: context.projectFallbackRate,
      source: "PROJECT_FALLBACK",
    };
  }
  if (context.clientFallbackRate != null) {
    return {
      hourlyRate: context.clientFallbackRate,
      source: "CLIENT_FALLBACK",
    };
  }
  return null;
}

