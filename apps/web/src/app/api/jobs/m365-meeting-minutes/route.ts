import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/automation/job-auth";
import { m365RuntimeGate, runMeetingMinutesJob } from "@/lib/m365/runtime";

// Jobs touch the database and must never be statically optimized.
export const dynamic = "force-dynamic";

/**
 * Microsoft 365 (M2) — atas por e-mail. Para cada Checkpoint em rascunho com
 * evento encerrado há menos de 7 dias e sem ata, consulta SÓ a caixa do gestor
 * (categoria JumpFlow / assunto do evento), gera a ata e os cards. Protegido por
 * `CRON_SECRET` (Bearer), mesmo contrato de `/api/jobs/*` (ADR08/ADR15). Lease
 * no banco por conexão do gestor: seguro chamar em paralelo/repetido. Com
 * `M365_INTEGRATION_ENABLED` desligada, não faz nada.
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
    const result = await runMeetingMinutesJob();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[job:m365-meeting-minutes] failed", (error as Error)?.name);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}

// Agendadores disparam com GET; mesmo handler e mesmo guard de CRON_SECRET.
export const GET = POST;
