import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QA (Fase M1) — server actions da integração: flag desligada deixa tudo
 * inerte (nem sessão é lida), ações sempre sobre a conexão do PRÓPRIO usuário
 * e "Sincronizar agora" mapeando o resultado sem detalhe técnico.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(async () => ({ id: "user-1", name: "Ana", email: "ana@jump.com.br", roles: ["CONSULTANT"] })),
  resolveDbUser: vi.fn(async () => ({ id: "user-1", name: "Ana", email: "ana@jump.com.br" })),
  getConsultantForUser: vi.fn(async () => ({ id: "cons-ana" })),
  db: {
    setOwnConnectionPaused: vi.fn(async () => true),
    findConnectionIdForUser: vi.fn(async () => "conn-1"),
    disconnectOwnConnection: vi.fn(async () => "conn-1"),
    dismissOwnSuggestion: vi.fn(async () => true),
    logM365Event: vi.fn(async () => {}),
  },
  syncConnectionNow: vi.fn(),
  recordAuditEvent: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({ requireUser: h.requireUser }));
vi.mock("@/lib/db/users", () => ({ resolveDbUser: h.resolveDbUser }));
vi.mock("@/lib/db/timesheet", () => ({ getConsultantForUser: h.getConsultantForUser }));
vi.mock("@/lib/db/m365", () => h.db);
vi.mock("@/lib/db/audit", () => ({ recordAuditEvent: h.recordAuditEvent }));
vi.mock("@/lib/m365/runtime", async (orig) => {
  const actual = await orig<typeof import("@/lib/m365/runtime")>();
  return { ...actual, syncConnectionNow: h.syncConnectionNow };
});

import { dismissM365TimeSuggestion } from "@/app/app/horas/m365-suggestion-actions";
import { disconnectM365, setM365Paused, syncM365Now } from "./actions";

function enable() {
  vi.stubEnv("M365_INTEGRATION_ENABLED", "true");
  vi.stubEnv("DATABASE_URL", "postgresql://fake");
  vi.stubEnv("M365_CLIENT_ID", "c");
  vi.stubEnv("M365_CLIENT_SECRET", "s");
  vi.stubEnv("M365_TENANT_ID", "11111111-2222-3333-4444-555555555555");
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

describe("flag desligada → ações inertes", () => {
  it("pausar, desconectar, sincronizar e ignorar sugestão não leem sessão nem banco", async () => {
    vi.stubEnv("M365_INTEGRATION_ENABLED", "");
    vi.stubEnv("DATABASE_URL", "postgresql://fake");
    expect(await setM365Paused(true)).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await disconnectM365()).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await syncM365Now()).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(await dismissM365TimeSuggestion("s1")).toMatchObject({ ok: false, error: "FORBIDDEN" });
    expect(h.requireUser).not.toHaveBeenCalled();
    for (const f of Object.values(h.db)) expect(f).not.toHaveBeenCalled();
    expect(h.syncConnectionNow).not.toHaveBeenCalled();
  });
});

describe("ações sobre a própria conexão", () => {
  it("desconectar usa o userId da sessão e audita tokensDeleted", async () => {
    enable();
    expect(await disconnectM365()).toEqual({ ok: true, data: null });
    expect(h.db.disconnectOwnConnection).toHaveBeenCalledWith("user-1");
    expect(h.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: "M365_DISCONNECTED", after: { status: "DISCONNECTED", tokensDeleted: true } }),
    );
  });

  it("pausar em estado inválido → NOT_EDITABLE sem auditoria", async () => {
    enable();
    h.db.setOwnConnectionPaused.mockResolvedValueOnce(false);
    expect(await setM365Paused(true)).toMatchObject({ ok: false, error: "NOT_EDITABLE" });
    expect(h.recordAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "ok" }, { ok: true, data: { status: "ok" } }],
    [{ status: "busy" }, { ok: true, data: { status: "busy" } }],
    [{ status: "interrupted", code: "throttled:429" }, { ok: true, data: { status: "interrupted" } }],
    [{ status: "skipped", reason: "not_active" }, { ok: false, error: "NOT_EDITABLE" }],
  ])("Sincronizar agora: %j → %j", async (result, expected) => {
    enable();
    h.syncConnectionNow.mockResolvedValueOnce(result);
    expect(await syncM365Now()).toMatchObject(expected);
    expect(h.syncConnectionNow).toHaveBeenCalledWith("conn-1");
  });

  it("Sincronizar agora com REAUTH: mensagem amigável, sem código técnico", async () => {
    enable();
    h.syncConnectionNow.mockResolvedValueOnce({ status: "error", code: "reauth:invalid_grant", connectionStatus: "REAUTH_REQUIRED" });
    const r = await syncM365Now();
    expect(r).toMatchObject({ ok: false, error: "UNEXPECTED" });
    expect(JSON.stringify(r)).not.toContain("invalid_grant");
    expect((r as { message: string }).message).toMatch(/Reconecte/);
  });

  it("ignorar sugestão: id validado e escopado ao consultor da sessão", async () => {
    enable();
    expect(await dismissM365TimeSuggestion("")).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(await dismissM365TimeSuggestion("x".repeat(65))).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    expect(await dismissM365TimeSuggestion("sug-1")).toEqual({ ok: true, data: null });
    expect(h.db.dismissOwnSuggestion).toHaveBeenCalledWith("cons-ana", "sug-1");
    h.db.dismissOwnSuggestion.mockResolvedValueOnce(false);
    expect(await dismissM365TimeSuggestion("sug-de-outro")).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });

  it("ignorar sugestão sem vínculo de consultor → NO_CONSULTANT", async () => {
    enable();
    h.getConsultantForUser.mockResolvedValueOnce(null as never);
    expect(await dismissM365TimeSuggestion("sug-1")).toMatchObject({ ok: false, error: "NO_CONSULTANT" });
    expect(h.db.dismissOwnSuggestion).not.toHaveBeenCalled();
  });
});
