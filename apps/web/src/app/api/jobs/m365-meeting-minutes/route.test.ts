import { afterEach, describe, expect, it, vi } from "vitest";

const { runMeetingMinutesJob } = vi.hoisted(() => ({
  runMeetingMinutesJob: vi.fn(async () => ({
    checkpoints: 0,
    managers: 0,
    saved: 0,
    ambiguous: 0,
    none: 0,
    failed: 0,
    busy: 0,
    skipped: 0,
    errors: 0,
  })),
}));
vi.mock("@/lib/m365/runtime", async (orig) => {
  const actual = await orig<typeof import("@/lib/m365/runtime")>();
  return { ...actual, runMeetingMinutesJob };
});

import * as route from "./route";

function req(auth?: string) {
  return new Request("http://localhost/api/jobs/m365-meeting-minutes", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

function enableAll() {
  vi.stubEnv("CRON_SECRET", "s3cret");
  vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://x");
  vi.stubEnv("M365_CLIENT_ID", "c");
  vi.stubEnv("M365_CLIENT_SECRET", "s");
  vi.stubEnv("M365_TENANT_ID", "11111111-2222-3333-4444-555555555555");
}

describe("/api/jobs/m365-meeting-minutes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runMeetingMinutesJob.mockClear();
  });

  it("GET é alias do POST (agendador usa GET)", () => {
    expect(route.GET).toBe(route.POST);
  });

  it("sem CRON_SECRET válido → 401, sem rodar nada", async () => {
    enableAll();
    const res = await route.GET(req("Bearer errado"));
    expect(res.status).toBe(401);
    expect(runMeetingMinutesJob).not.toHaveBeenCalled();
  });

  it("flag desligada → inerte", async () => {
    enableAll();
    vi.stubEnv("M365_INTEGRATION_ENABLED", "");
    const res = await route.GET(req("Bearer s3cret"));
    expect(await res.json()).toEqual({ ok: true, skipped: "disabled" });
    expect(runMeetingMinutesJob).not.toHaveBeenCalled();
  });

  it("tudo configurado → roda o job", async () => {
    enableAll();
    const res = await route.GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(runMeetingMinutesJob).toHaveBeenCalledTimes(1);
  });

  it("falha inesperada → 500 genérico, sem detalhe", async () => {
    enableAll();
    runMeetingMinutesJob.mockRejectedValueOnce(new Error("segredo interno"));
    const res = await route.GET(req("Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("segredo");
  });
});
