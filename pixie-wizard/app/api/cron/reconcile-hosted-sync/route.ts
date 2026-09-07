import { NextResponse } from "next/server";
import { reconcileHostedSync } from "@/lib/hostedReconcile";

// Separate from (and does not touch) the legacy dedicated/Railway trial
// path — this only retries hosted programs whose config hasn't reached
// Core yet. See lib/hostedReconcile.ts.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const result = await reconcileHostedSync();
  return NextResponse.json({ ok: true, ...result });
}
