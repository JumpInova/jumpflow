import { describe, expect, it } from "vitest";
import {
  findOverlappingSaleRate,
  rangesOverlap,
  resolveSaleRate,
  saleRateScopeKey,
  type SaleRateRange,
} from "./rates";

const projectRate: SaleRateRange = {
  id: "rate-project",
  projectId: "project-1",
  startsAt: "2026-01-01",
  endsAt: "2026-06-01",
  hourlyRate: 300,
};

describe("sale rates", () => {
  it("uses semi-open date ranges", () => {
    expect(
      rangesOverlap(
        { startsAt: "2026-01-01", endsAt: "2026-02-01" },
        { startsAt: "2026-02-01", endsAt: "2026-03-01" },
      ),
    ).toBe(false);
    expect(
      rangesOverlap(
        { startsAt: "2026-01-01", endsAt: null },
        { startsAt: "2026-12-01", endsAt: null },
      ),
    ).toBe(true);
  });

  it("detects overlaps only within the same scope", () => {
    const existing: SaleRateRange[] = [
      projectRate,
      {
        ...projectRate,
        id: "rate-consultant",
        consultantId: "consultant-1",
        hourlyRate: 340,
      },
    ];
    expect(
      findOverlappingSaleRate(existing, {
        ...projectRate,
        id: "new-project-overlap",
        startsAt: "2026-05-01",
        endsAt: "2026-07-01",
      })?.id,
    ).toBe("rate-project");
    expect(
      findOverlappingSaleRate(existing, {
        ...projectRate,
        id: "new-allocation",
        allocationId: "allocation-1",
        startsAt: "2026-05-01",
        endsAt: "2026-07-01",
      }),
    ).toBeUndefined();
  });

  it("resolves allocation, consultant, project and fallback precedence", () => {
    const rates: SaleRateRange[] = [
      projectRate,
      {
        ...projectRate,
        id: "rate-consultant",
        consultantId: "consultant-1",
        hourlyRate: 340,
      },
      {
        ...projectRate,
        id: "rate-allocation",
        consultantId: "consultant-1",
        allocationId: "allocation-1",
        hourlyRate: 360,
      },
    ];
    expect(
      resolveSaleRate(rates, {
        date: "2026-03-01",
        consultantId: "consultant-1",
        allocationId: "allocation-1",
      }),
    ).toMatchObject({ hourlyRate: 360, source: "ALLOCATION" });
    expect(
      resolveSaleRate(rates, {
        date: "2026-03-01",
        consultantId: "consultant-1",
      }),
    ).toMatchObject({ hourlyRate: 340, source: "CONSULTANT" });
    expect(resolveSaleRate(rates, { date: "2026-03-01" })).toMatchObject({
      hourlyRate: 300,
      source: "PROJECT",
    });
    expect(
      resolveSaleRate([], {
        date: "2026-03-01",
        projectFallbackRate: 280,
        clientFallbackRate: 250,
      }),
    ).toMatchObject({ hourlyRate: 280, source: "PROJECT_FALLBACK" });
  });

  it("builds stable scope keys", () => {
    expect(saleRateScopeKey(projectRate)).toBe("project:project-1");
    expect(
      saleRateScopeKey({ ...projectRate, consultantId: "consultant-1" }),
    ).toBe("project:project-1:consultant:consultant-1");
    expect(
      saleRateScopeKey({ ...projectRate, allocationId: "allocation-1" }),
    ).toBe("allocation:allocation-1");
  });

  it("desempata faixas do mesmo dia pelo maior id, independente da ordem de leitura", () => {
    const a = { id: "rate-a", projectId: "p", startsAt: "2026-03-01", hourlyRate: 100 };
    const b = { id: "rate-b", projectId: "p", startsAt: "2026-03-01", hourlyRate: 200 };
    const older = { id: "rate-z", projectId: "p", startsAt: "2026-02-01", hourlyRate: 50 };
    for (const order of [[a, b, older], [b, a, older], [older, a, b]]) {
      expect(resolveSaleRate(order, { date: "2026-03-10" })).toMatchObject({
        hourlyRate: 200,
        rateId: "rate-b",
      });
    }
    // Ordem binária (COLLATE "C"): maiúscula < minúscula.
    const upper = { ...a, id: "Z-rate", hourlyRate: 300 };
    expect(resolveSaleRate([upper, a], { date: "2026-03-10" })?.rateId).toBe("rate-a");
  });
});
