import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/automation/job-auth";
import { isDatabaseConfigured } from "@/lib/db/config";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Envio agendado de Consultas (C3). Protegido por `CRON_SECRET` (mesmo
 * contrato de `/api/jobs/*`). Pode ser chamado com frequência (ex.: a cada
 * 15 min): só envia janelas vencidas, e cada (agendamento, janela) é enviada
 * uma vez só (run UNIQUE + lease no banco). Cada destinatário recebe a
 * planilha gerada com a PRÓPRIA permissão.
 */
export async function POST(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ ok: false, error: "no_database" }, { status: 503 });
  }
  try {
    const { runConsultaSchedules } = await import("@/lib/db/consultas-schedules");
    const result = await runConsultaSchedules();
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("[job:consultas-agendadas] failed", error);
    return NextResponse.json({ ok: false, error: "internal_error" }, { status: 500 });
  }
}

// Agendadores disparam com um GET (sem corpo).
export const GET = POST;
