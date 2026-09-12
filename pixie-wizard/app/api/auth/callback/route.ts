import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isAllowed, setSessionCookie } from "@/lib/session";
import { timeoutFetch } from "@/lib/timeoutFetch";
import { listHostedProgramsForOwner, listProgramAccessForPerson } from "@/lib/hostedPrograms";
import { isSuperadminSession } from "@/lib/programAccess";

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

  const fail = (reason: string) =>
    NextResponse.redirect(`${process.env.BASE_URL}/?error=${reason}`);

  if (!code || !state || !expected || state !== expected) return fail("state");

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

  if (!tokenRes.ok) return fail("token");

  const tokens = (await tokenRes.json()) as HackClubTokenResponse;

  const meRes = await timeoutFetch(`${HCA_BASE_URL}/api/v1/me`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!meRes.ok) return fail("identity");

  const me = (await meRes.json()) as HackClubMeResponse;
  const identity = me.identity;
  const email = identity.primary_email;
  if (!email) return fail("denied");

  const fullName = [identity.first_name, identity.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  const name = fullName || email;

  if (!isAllowed({ hcaId: identity.id, email })) return fail("denied");

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
  // through a page that would just redirect them again.
  const who = { hcaId: identity.id, email };
  let destination = "/wizard";
  if (await isSuperadminSession(who)) {
    destination = "/programs";
  } else {
    const [owned, helping] = await Promise.all([
      listHostedProgramsForOwner(who).catch(() => []),
      listProgramAccessForPerson(identity.id).catch(() => []),
    ]);
    if (owned[0]) destination = `/programs/${owned[0].id}`;
    else if (helping[0]) destination = `/programs/${helping[0].id}`;
  }
  return NextResponse.redirect(`${process.env.BASE_URL}${destination}`);
}
