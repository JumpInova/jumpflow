import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addConnection, createMemoryStore, type MemoryState } from "./testing/memory-store";
import type { M365Store } from "./store";
import { encryptAccessToken, encryptRefreshToken } from "./tokens";

/**
 * QA (Fase M1) — composição de produção (runtime) com o store em memória no
 * lugar do Prisma e fetch global stubado (nenhuma chamada real ao Graph):
 * gate da flag, job × "Sincronizar agora" no mesmo lease, resumo do job.
 */

const h = vi.hoisted(() => ({
  store: null as unknown as M365Store,
  state: null as unknown as MemoryState,
  due: [] as string[],
}));

vi.mock("@/lib/db/m365", () => ({
  get prismaM365Store() {
    return h.store;
  },
  listDueConnectionIds: vi.fn(async () => h.due),
}));

import { m365RuntimeGate, runCalendarSyncJob, syncConnectionNow } from "./runtime";

function enable() {
  vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://fake");
  vi.stubEnv("M365_CLIENT_ID", "c");
  vi.stubEnv("M365_CLIENT_SECRET", "s");
  vi.stubEnv("M365_TENANT_ID", "11111111-2222-3333-4444-555555555555");
}

function stubGraph() {
  const fetch = vi.fn(async (url: string) => {
    if (url.includes("login.microsoftonline.com")) {
      return new Response(JSON.stringify({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600 }), { status: 200 });
    }
    if (url.startsWith("https://graph.microsoft.com/")) {
      return new Response(
        JSON.stringify({ value: [], "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=1" }),
        { status: 200 },
      );
    }
    throw new Error(`URL inesperada: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  const { store, state } = createMemoryStore();
  h.store = store;
  h.state = state;
  state.users.set("u1", { user: { id: "u1", name: "U", email: "u1@jump.com.br", roles: ["CONSULTANT"] }, consultantId: null });
  for (const id of ["c1", "c2"]) {
    addConnection(state, {
      id,
      userId: "u1",
      mailbox: "u1@jump.com.br",
      accessTokenEncrypted: encryptAccessToken("AT-OLD"),
      refreshTokenEncrypted: encryptRefreshToken("RT-OLD"),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }
  h.due = ["c1", "c2"];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("m365RuntimeGate", () => {
  it("ordem dos motivos: disabled → no_database → missing_credentials → forbidden_tenant", () => {
    vi.stubEnv("M365_INTEGRATION_ENABLED", "");
    expect(m365RuntimeGate()).toEqual({ ok: false, reason: "disabled" });
    vi.stubEnv("M365_INTEGRATION_ENABLED", "1");
    vi.stubEnv("DATABASE_URL", "");
    expect(m365RuntimeGate()).toEqual({ ok: false, reason: "no_database" });
    vi.stubEnv("DATABASE_URL", "postgresql://fake");
    vi.stubEnv("M365_CLIENT_ID", "");
    vi.stubEnv("AUTH_MICROSOFT_ENTRA_ID_ID", "");
    expect(m365RuntimeGate()).toEqual({ ok: false, reason: "missing_credentials" });
    enable();
    vi.stubEnv("M365_TENANT_ID", "organizations");
    expect(m365RuntimeGate()).toEqual({ ok: false, reason: "forbidden_tenant" });
    enable();
    expect(m365RuntimeGate()).toEqual({ ok: true });
  });
});

describe("job e 'Sincronizar agora'", () => {
  it("job sincroniza as conexões devidas e respeita o lease do 'Sincronizar agora'", async () => {
    enable();
    const fetch = stubGraph();
    const c2 = h.state.connections.get("c2")!;
    c2.leaseOwner = "user:em-andamento";
    c2.leaseUntil = new Date(Date.now() + 60_000);
    const summary = await runCalendarSyncJob();
    expect(summary).toEqual({ processed: 2, ok: 1, busy: 1, interrupted: 0, errors: 0, skipped: 0 });
    expect(c2.leaseOwner).toBe("user:em-andamento");
    // Só c1 falou com o Graph (uma chamada de delta, token ainda válido).
    expect(fetch).toHaveBeenCalledTimes(1);
    const auth = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;
    expect(auth.Authorization).toBe("Bearer AT-OLD");
    expect(h.state.connections.get("c1")!.leaseOwner).toBeNull();
  });

  it("'Sincronizar agora' com o job segurando o lease → busy, sem Graph", async () => {
    enable();
    const fetch = stubGraph();
    const c1 = h.state.connections.get("c1")!;
    c1.leaseOwner = "job:abc";
    c1.leaseUntil = new Date(Date.now() + 60_000);
    expect(await syncConnectionNow("c1")).toEqual({ status: "busy" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("job com prazo esgotado não processa nada", async () => {
    enable();
    const fetch = stubGraph();
    const summary = await runCalendarSyncJob({ roundMs: 0 });
    expect(summary.processed).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("token expirando renova pelo endpoint do tenant configurado e persiste cifrado", async () => {
    enable();
    const fetch = stubGraph();
    h.state.connections.get("c1")!.expiresAt = new Date(Date.now() + 60_000); // < 5 min
    h.due = ["c1"];
    await runCalendarSyncJob();
    const urls = fetch.mock.calls.map((c) => String((c as unknown as [string])[0]));
    expect(urls[0]).toBe("https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/oauth2/v2.0/token");
    const conn = h.state.connections.get("c1")!;
    expect(conn.refreshTokenEncrypted).not.toContain("RT-NEW");
    expect(conn.accessTokenEncrypted).not.toContain("AT-NEW");
  });
});
