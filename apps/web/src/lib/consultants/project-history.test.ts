import { describe, expect, it } from "vitest";
import {
  compareProjectHistory,
  deriveProjectHistoryStatus,
  isHistoryRelevant,
} from "./project-history";

const today = "2026-11-26";

describe("deriveProjectHistoryStatus", () => {
  it("is ACTIVE for an ACTIVE allocation covering today", () => {
    expect(
      deriveProjectHistoryStatus(
        { status: "ACTIVE", startDate: "2026-01-01", endDate: null },
        today,
      ),
    ).toBe("ACTIVE");
    expect(
      deriveProjectHistoryStatus(
        { status: "ACTIVE", startDate: "2026-01-01", endDate: today },
        today,
      ),
    ).toBe("ACTIVE");
  });

  it("is INACTIVE when the end date already passed, even if status is ACTIVE", () => {
    expect(
      deriveProjectHistoryStatus(
        { status: "ACTIVE", startDate: "2026-01-01", endDate: "2026-11-25" },
        today,
      ),
    ).toBe("INACTIVE");
  });

  it("is INACTIVE before the start date", () => {
    expect(
      deriveProjectHistoryStatus(
        { status: "ACTIVE", startDate: "2026-12-01", endDate: null },
        today,
      ),
    ).toBe("INACTIVE");
  });

  it.each(["PLANNED", "ENDED", "INACTIVE"] as const)(
    "is INACTIVE for %s allocations",
    (status) => {
      expect(
        deriveProjectHistoryStatus(
          { status, startDate: "2026-01-01", endDate: null },
          today,
        ),
      ).toBe("INACTIVE");
    },
  );
});

describe("isHistoryRelevant", () => {
  it("drops cancelled allocations only", () => {
    expect(isHistoryRelevant("CANCELLED")).toBe(false);
    expect(isHistoryRelevant("ENDED")).toBe(true);
  });
});

describe("compareProjectHistory", () => {
  it("orders active first, then most recent start", () => {
    const rows = [
      { status: "INACTIVE" as const, startDate: "2026-06-01", projectName: "B" },
      { status: "ACTIVE" as const, startDate: "2025-01-01", projectName: "A" },
      { status: "INACTIVE" as const, startDate: "2026-09-01", projectName: "C" },
    ];
    expect(rows.sort(compareProjectHistory).map((r) => r.projectName)).toEqual([
      "A",
      "C",
      "B",
    ]);
  });
});
