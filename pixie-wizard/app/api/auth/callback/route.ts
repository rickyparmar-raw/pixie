import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAllowed, setSessionCookie } from "@/lib/session";
import { timeoutFetch } from "@/lib/timeoutFetch";
import { isSuperadminSession, ownProgramPath } from "@/lib/programAccess";

const HCA_BASE_URL = "https://auth.hackclub.com";

interface HackClubTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

interface HackClubMeResponse {
  identity: {
    id: string;
    first_name?: string;
    last_name?: string;
    primary_email?: string;
    slack_id?: string;
    verification_status?: string;
    [key: string]: unknown;
  };
  scopes: string[];
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const jar = await cookies();
  const expected = jar.get("pixie_wizard_oauth_state")?.value;
  jar.delete("pixie_wizard_oauth_state");

  // Every branch logs its reason (no secrets — ids/emails/status codes only)
  // so a failed sign-in is diagnosable from Railway logs instead of just
  // being "it redirected me to the homepage" with no further signal.
  const fail = (reason: string, detail?: string) => {
    console.warn(`[auth/callback] failed: ${reason}${detail ? ` — ${detail}` : ""}`);
    return NextResponse.redirect(`${process.env.BASE_URL}/?error=${reason}`);
  };

  if (!code || !state || !expected || state !== expected) {
    return fail("state", `code=${Boolean(code)} state=${Boolean(state)} expected=${Boolean(expected)} match=${state === expected}`);
  }

  const tokenRes = await timeoutFetch(`${HCA_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.HCA_CLIENT_ID,
      client_secret: process.env.HCA_CLIENT_SECRET,
      redirect_uri: `${process.env.BASE_URL}/api/auth/callback`,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenRes.ok) return fail("token", `HCA /oauth/token returned ${tokenRes.status}`);

  const tokens = (await tokenRes.json()) as HackClubTokenResponse;

  const meRes = await timeoutFetch(`${HCA_BASE_URL}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!meRes.ok) return fail("identity", `HCA /api/v1/me returned ${meRes.status}`);

  const me = (await meRes.json()) as HackClubMeResponse;
  const identity = me.identity;
  const email = identity.primary_email;
  if (!email) {
    return fail("no-email", `hca identity ${identity.id} has no primary_email (verification_status=${identity.verification_status ?? "unknown"})`);
  }

  const fullName = [identity.first_name, identity.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const name = fullName || email;

  if (!isAllowed({ hcaId: identity.id, email })) return fail("not-allowed", `${identity.id} is not on PIXIE_WIZARD_ALLOWLIST`);

  await setSessionCookie({
    hcaId: identity.id,
    email,
    name,
    slackId: identity.slack_id ?? null,
  });

  // /wizard is the *create a new hosted program* flow — for a creator-
  // eligible account it fetches every Slack channel from Core before it can
  // render anything. Sending every login through it meant a returning owner
  // or helper paid for that Core round trip just to get bounced onward.
  // /programs (the cross-program directory) is superadmin-only, so a normal
  // owner/helper goes straight to their own program instead of bouncing
  // through a page that would just redirect them again. Shares ownProgramPath
  // with the in-app redirect (requireWizardSuperadmin) so there is exactly
  // one place that decides "does this account have a program" — the two
  // paths silently disagreeing (one recognized Slack-added helpers, the
  // other didn't) is what caused a real working helper to see "invite-only."
  const who = { hcaId: identity.id, email, slackId: identity.slack_id ?? null };
  const destination = (await isSuperadminSession(who)) ? "/programs" : await ownProgramPath(who);
  return NextResponse.redirect(`${process.env.BASE_URL}${destination}`);
}
