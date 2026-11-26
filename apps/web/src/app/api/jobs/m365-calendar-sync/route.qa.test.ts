import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * QA (Fase M1) — contrato CRON_SECRET do job da agenda e flag desligada.
 */

const { runCalendarSyncJob } = vi.hoisted(() => ({
  runCalendarSyncJob: vi.fn(async () => ({ processed: 0, ok: 0, busy: 0, interrupted: 0, errors: 0, skipped: 0 })),
}));
vi.mock("@/lib/m365/runtime", async (orig) => {
  const actual = await orig<typeof import("@/lib/m365/runtime")>();
  return { ...actual, runCalendarSyncJob };
});

import * as route from "./route";

function req(method: "GET" | "POST", auth?: string) {
  return new Request("http://localhost/api/jobs/m365-calendar-sync", {
    method,
    headers: auth ? { authorization: auth } : {},
  });
}

function enable() {
  vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://x");
  vi.stubEnv("M365_CLIENT_ID", "c");
  vi.stubEnv("M365_CLIENT_SECRET", "s");
  vi.stubEnv("M365_TENANT_ID", "11111111-2222-3333-4444-555555555555");
}

describe("/api/jobs/m365-calendar-sync — CRON_SECRET", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runCalendarSyncJob.mockReset();
    runCalendarSyncJob.mockImplementation(async () => ({ processed: 0, ok: 0, busy: 0, interrupted: 0, errors: 0, skipped: 0 }));
  });

  it("produção sem CRON_SECRET configurado → 401 (nunca aberto)", async () => {
    enable();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "");
    expect((await route.GET(req("GET", "Bearer qualquer"))).status).toBe(401);
    expect(runCalendarSyncJob).not.toHaveBeenCalled();
  });

  it.each([undefined, "s3cret", "Bearer", "Bearer s3cre", "bearer s3cret", "Basic s3cret"])(
    "Authorization %j → 401",
    async (auth) => {
      enable();
      vi.stubEnv("CRON_SECRET", "s3cret");
      expect((await route.POST(req("POST", auth))).status).toBe(401);
      expect(runCalendarSyncJob).not.toHaveBeenCalled();
    },
  );

  it("401 vem antes da flag: sem segredo, nem a flag é revelada", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("M365_INTEGRATION_ENABLED", "");
    const res = await route.GET(req("GET"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it.each([
    ["no_database", { DATABASE_URL: "" }],
    ["forbidden_tenant", { M365_TENANT_ID: "common" }],
  ])("gate %s → skipped sem rodar o job", async (reason, env) => {
    enable();
    vi.stubEnv("CRON_SECRET", "s3cret");
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const res = await route.GET(req("GET", "Bearer s3cret"));
    expect(await res.json()).toEqual({ ok: true, skipped: reason });
    expect(runCalendarSyncJob).not.toHaveBeenCalled();
  });

  it("falha inesperada do job → 500 genérico, sem detalhe", async () => {
    enable();
    vi.stubEnv("CRON_SECRET", "s3cret");
    runCalendarSyncJob.mockRejectedValueOnce(new Error("Bearer AT-SECRETO vazou"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await route.POST(req("POST", "Bearer s3cret"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("AT-SECRETO");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("AT-SECRETO");
    spy.mockRestore();
  });
});
