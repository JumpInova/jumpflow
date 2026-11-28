import { afterEach, describe, expect, it, vi } from "vitest";

const { runCalendarSyncJob } = vi.hoisted(() => ({
  runCalendarSyncJob: vi.fn(async () => ({ processed: 0, ok: 0, busy: 0, interrupted: 0, errors: 0, skipped: 0 })),
}));
vi.mock("@/lib/m365/runtime", async (orig) => {
  const actual = await orig<typeof import("@/lib/m365/runtime")>();
  return { ...actual, runCalendarSyncJob };
});

import * as route from "./route";

function req(auth?: string) {
  return new Request("http://localhost/api/jobs/m365-calendar-sync", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

describe("/api/jobs/m365-calendar-sync", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runCalendarSyncJob.mockClear();
  });

  it("GET é alias do POST (agendador usa GET)", () => {
    expect(route.GET).toBe(route.POST);
  });

  it("sem CRON_SECRET válido → 401, sem rodar nada", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
    const res = await route.GET(req("Bearer errado"));
    expect(res.status).toBe(401);
    expect(runCalendarSyncJob).not.toHaveBeenCalled();
  });

  it("flag desligada → inerte (não roda o job)", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("M365_INTEGRATION_ENABLED", "");
    const res = await route.GET(req("Bearer s3cret"));
    expect(await res.json()).toEqual({ ok: true, skipped: "disabled" });
    expect(runCalendarSyncJob).not.toHaveBeenCalled();
  });

  it("flag ligada + banco + credenciais → roda o job", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
    vi.stubEnv("DATABASE_URL", "postgresql://x");
    vi.stubEnv("M365_CLIENT_ID", "c");
    vi.stubEnv("M365_CLIENT_SECRET", "s");
    vi.stubEnv("M365_TENANT_ID", "11111111-2222-3333-4444-555555555555");
    const res = await route.GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(runCalendarSyncJob).toHaveBeenCalledTimes(1);
  });
});
