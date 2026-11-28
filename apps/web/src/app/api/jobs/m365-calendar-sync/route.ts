import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/automation/job-auth";
import { m365RuntimeGate, runCalendarSyncJob } from "@/lib/m365/runtime";

// Jobs touch the database and must never be statically optimized.
export const dynamic = "force-dynamic";

/**
 * Microsoft 365 (M1) — sync delta da agenda das conexões ACTIVE. Protegido por
 * `CRON_SECRET` (Bearer), mesmo contrato de `/api/jobs/*` (ADR08/ADR15).
 * Concorrência resolvida por lease no banco por conexão; seguro chamar em
 * paralelo/repetido. Com `M365_INTEGRATION_ENABLED` desligada, não faz nada.
 */
export async function POST(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const gate = m365RuntimeGate();
  if (!gate.ok) {
    return NextResponse.json({ ok: true, skipped: gate.reason });
  }
  try {
    const result = await runCalendarSyncJob();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[job:m365-calendar-sync] failed", (error as Error)?.name);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}

// Agendadores disparam com GET; mesmo handler e mesmo guard de CRON_SECRET.
export const GET = POST;
