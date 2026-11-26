import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/automation/job-auth";
import { m365RuntimeGate, runTeamsTranscriptsJob } from "@/lib/m365/runtime";

// Jobs touch the database and must never be statically optimized.
export const dynamic = "force-dynamic";

/**
 * Microsoft 365 (M3) — transcrição do Teams. Para cada Checkpoint em rascunho
 * cuja reunião Teams foi ORGANIZADA pelo gestor conectado (com os escopos do
 * Teams), entre 10 min e 48 h após o fim: procura a reunião pelo link, lê a
 * transcrição (VTT só em memória), mascara, gera a ata e os cards. Backoff
 * 15/30/60/120 min até 6 h; 403 = 24 h sem nova tentativa. Protegido por
 * `CRON_SECRET` (Bearer), mesmo contrato de `/api/jobs/*` (ADR08/ADR15). Claim
 * atômico por registro + lease da conexão no banco: seguro chamar em
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
    const result = await runTeamsTranscriptsJob();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[job:m365-teams-transcripts] failed", (error as Error)?.name);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}

// Agendadores disparam com GET; mesmo handler e mesmo guard de CRON_SECRET.
export const GET = POST;
