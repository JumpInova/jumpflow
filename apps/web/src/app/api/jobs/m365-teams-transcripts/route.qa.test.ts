import { afterEach, describe, expect, it, vi } from "vitest";

/** QA M3 — contrato CRON_SECRET e flag do job de transcrições do Teams (complementa `route.test.ts`). */

const { runTeamsTranscriptsJob } = vi.hoisted(() => ({
  runTeamsTranscriptsJob: vi.fn(async () => ({
    enrolled: 0,
    checkpoints: 0,
    managers: 0,
    saved: 0,
    waiting: 0,
    noTranscript: 0,
    failed: 0,
    busy: 0,
    skipped: 0,
    errors: 0,
  })),
}));
vi.mock("@/lib/m365/runtime", async (orig) => {
  const actual = await orig<typeof import("@/lib/m365/runtime")>();
  return { ...actual, runTeamsTranscriptsJob };
});

import * as route from "./route";

function req(auth?: string) {
  return new Request("http://localhost/api/jobs/m365-teams-transcripts", {
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

describe("/api/jobs/m365-teams-transcripts — QA", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    runTeamsTranscriptsJob.mockClear();
  });

  it("produção sem CRON_SECRET configurado → 401 (nunca endpoint aberto)", async () => {
    enableAll();
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    for (const auth of [undefined, "Bearer ", "Bearer undefined"]) {
      expect((await route.POST(req(auth))).status).toBe(401);
    }
    expect(runTeamsTranscriptsJob).not.toHaveBeenCalled();
  });

  it("sem header, segredo na query string ou esquema errado → 401", async () => {
    enableAll();
    const viaQuery = new Request("http://localhost/api/jobs/m365-teams-transcripts?secret=s3cret&token=s3cret", { method: "GET" });
    for (const r of [req(), viaQuery, req("s3cret"), req("Basic s3cret"), req("bearer s3cret"), req("Bearer s3cret2")]) {
      expect((await route.GET(r)).status).toBe(401);
    }
    expect(runTeamsTranscriptsJob).not.toHaveBeenCalled();
  });

  it.each(["false", "0", "off", "no", " "])("flag M365_INTEGRATION_ENABLED=%j → inerte mesmo com segredo válido", async (flag) => {
    enableAll();
    vi.stubEnv("M365_INTEGRATION_ENABLED", flag);
    const res = await route.POST(req("Bearer s3cret"));
    expect(await res.json()).toEqual({ ok: true, skipped: "disabled" });
    expect(runTeamsTranscriptsJob).not.toHaveBeenCalled();
  });

  it("flag ligada sem banco ou sem credenciais → inerte (skipped), sem rodar", async () => {
    enableAll();
    vi.stubEnv("DATABASE_URL", "");
    expect(await (await route.POST(req("Bearer s3cret"))).json()).toMatchObject({ ok: true, skipped: "no_database" });
    enableAll();
    for (const k of ["M365_CLIENT_ID", "M365_CLIENT_SECRET", "M365_TENANT_ID", "AUTH_MICROSOFT_ENTRA_ID_ID", "AUTH_MICROSOFT_ENTRA_ID_SECRET", "AUTH_MICROSOFT_ENTRA_ID_ISSUER", "AUTH_MICROSOFT_ENTRA_ID_TENANT_ID"]) {
      vi.stubEnv(k, "");
    }
    const body = await (await route.POST(req("Bearer s3cret"))).json();
    expect(body.ok).toBe(true);
    expect(body.skipped).toBeTruthy();
    expect(runTeamsTranscriptsJob).not.toHaveBeenCalled();
  });

  it("resposta do job só com contadores (nenhum id/texto do resultado além dos números)", async () => {
    enableAll();
    const body = await (await route.GET(req("Bearer s3cret"))).json();
    expect(body.ok).toBe(true);
    for (const v of Object.values(body.result as Record<string, unknown>)) expect(typeof v).toBe("number");
  });
});
