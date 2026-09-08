import { NextResponse } from "next/server";
import { reconcileHostedSync } from "@/lib/hostedReconcile";
import { listActiveHostedPrograms, listHostedChannels } from "@/lib/hostedPrograms";

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
  const forceAll = url.searchParams.get("all") === "true";
  const result = await reconcileHostedSync({ forceAll });
  const active = await listActiveHostedPrograms();
  const programs = await Promise.all(active.map(async (p) => ({
    id: p.id,
    name: p.program_name,
    workspace: p.workspace_id,
    channels: await listHostedChannels(p.id)
  })));
  return NextResponse.json({ ok: true, ...result, programs });
}
