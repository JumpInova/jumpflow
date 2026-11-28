import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runConsultaSchedules, isDatabaseConfigured } = vi.hoisted(() => ({
  runConsultaSchedules: vi.fn(),
  isDatabaseConfigured: vi.fn(() => true),
}));
vi.mock("@/lib/db/consultas-schedules", () => ({ runConsultaSchedules }));
vi.mock("@/lib/db/config", () => ({ isDatabaseConfigured }));

import * as route from "./route";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/jobs/consultas-agendadas", { method: "GET", headers });
}

describe("/api/jobs/consultas-agendadas (contrato CRON_SECRET)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runConsultaSchedules.mockResolvedValue({ checked: 1, due: 1, processed: 1, busy: 0, sent: 1, skipped: 0, failed: 0 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("GET é alias de POST (agendadores só fazem GET)", () => {
    expect(route.GET).toBe(route.POST);
  });

  it("401 sem Bearer ou com segredo errado, sem rodar o job", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await route.GET(req())).status).toBe(401);
    expect((await route.GET(req({ authorization: "Bearer errado" }))).status).toBe(401);
    expect(runConsultaSchedules).not.toHaveBeenCalled();
  });

  it("produção sem CRON_SECRET configurado → 401", async () => {
    vi.stubEnv("CRON_SECRET", "");
    vi.stubEnv("NODE_ENV", "production");
    expect((await route.GET(req())).status).toBe(401);
  });

  it("com o segredo certo roda e devolve o resumo", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = await route.GET(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, result: { sent: 1 } });
  });

  it("sem banco → 503; erro interno → 500 genérico", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    isDatabaseConfigured.mockReturnValueOnce(false);
    expect((await route.GET(req({ authorization: "Bearer s3cret" }))).status).toBe(503);
    runConsultaSchedules.mockRejectedValueOnce(new Error("relation does not exist"));
    const res = await route.GET(req({ authorization: "Bearer s3cret" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});
