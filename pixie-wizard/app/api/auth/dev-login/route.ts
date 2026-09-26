import { NextRequest, NextResponse } from "next/server";
import { isLocalDemoEnabled, isLoopbackHost, setSessionCookie } from "@/lib/session";

export async function GET(request: NextRequest) {
  const host = request.headers.get("host");
  if (!isLocalDemoEnabled() || !host || !isLoopbackHost(host)) {
    return NextResponse.json({ error: "not available" }, { status: 404 });
  }

  await setSessionCookie({
    hcaId: "dev-local",
    email: "dev@localhost",
    name: "Local Dev",
    // Unlinked by default, like a fresh Hack Club Auth account. Set
    // PIXIE_DEV_SLACK_ID to exercise the Slack-linked helper actions locally.
    slackId: process.env.PIXIE_DEV_SLACK_ID || null,
  });
  const destination = new URL("/wizard", request.url);
  destination.host = host;
  return NextResponse.redirect(destination);
}
