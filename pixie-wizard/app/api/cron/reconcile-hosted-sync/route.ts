import { NextResponse } from "next/server";
import { reconcileHostedSync } from "@/lib/hostedReconcile";
import { listActiveHostedPrograms, listHostedChannels } from "@/lib/hostedPrograms";

import { query } from "@/lib/db";

// Separate from (and does not touch) the legacy dedicated/Railway trial
// path — this only retries hosted programs whose config hasn't reached
// Core yet. See lib/hostedReconcile.ts.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = new URL(req.url);
  if (url.searchParams.get("fixSandbox") === "true") {
    await query(`update hosted_program_channels set kind = 'help' where program_id = 'pixie-sandbox-e2e' and channel_id = 'C0C04LB6VA5'`);
    await query(`update hosted_program_channels set kind = 'organizer' where program_id = 'pixie-sandbox-e2e' and channel_id = 'C0BVCFXJMRB'`);
  }
  const forceAll = url.searchParams.get("all") === "true" || url.searchParams.get("fixSandbox") === "true";
  const result = await reconcileHostedSync({ forceAll });
  const active = await listActiveHostedPrograms();
  const programs = await Promise.all(active.map(async (p) => ({
    id: p.id,
    name: p.program_name,
    workspace: p.workspace_id,
    support_name: p.support_name,
    icon_url: p.icon_url,
    reply_signature: p.reply_signature,
    posture: p.posture,
    scope: p.scope,
    ai_answers: p.ai_answers,
    tickets_enabled: p.tickets_enabled,
    public_tickets_enabled: p.public_tickets_enabled,
    auto_escalate: p.auto_escalate,
    incident_mode: p.incident_mode,
    settings: p.settings,
    channels: await listHostedChannels(p.id)
  })));
  return NextResponse.json({ ok: true, ...result, programs });
}
