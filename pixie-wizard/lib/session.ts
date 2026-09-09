import { cache } from "react";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

const COOKIE = "pixie_wizard_session";
const MAX_AGE = 60 * 60 * 24 * 7;

export interface WizardSession {
  hcaId: string;
  email: string;
  name: string;
  slackId: string | null;
  exp: number;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is not set");
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function encodeSession(session: WizardSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(raw: string | undefined): WizardSession | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as WizardSession;
    if (session.exp < Date.now() / 1000) return null;
    return session;
  } catch {
    return null;
  }
}

// Request-scoped memo: the layout, the page, and any nested server component
// all call getSession() on the same request — React.cache collapses that to
// one cookie read + one HMAC verify per request. cache() is per-request by
// construction (it holds nothing between requests) and outside a request
// scope it simply passes through, so it never becomes a shared/persistent
// auth cache.
export const getSession = cache(async (): Promise<WizardSession | null> => {
  const jar = await cookies();
  return decodeSession(jar.get(COOKIE)?.value);
});

export async function setSessionCookie(session: Omit<WizardSession, "exp">) {
  const jar = await cookies();
  jar.set(
    COOKIE,
    encodeSession({ ...session, exp: Date.now() / 1000 + MAX_AGE }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.BASE_URL?.startsWith("https") ?? false,
      maxAge: MAX_AGE,
      path: "/",
    },
  );
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.delete(COOKIE);
}

// True when `identifier` names this session's account — its HCA id or its
// email, case-insensitive. No domain match (that would be far too broad for
// ownership). An owner_hca_id column may therefore hold either form, so an
// owner set by email (e.g. a hand-transferred program) still resolves.
export function ownsIdentifier(
  identifier: string | null | undefined,
  session: { hcaId: string; email: string },
): boolean {
  if (!identifier) return false;
  const id = identifier.trim().toLowerCase();
  if (!id) return false;
  return id === session.hcaId.toLowerCase() || id === session.email.toLowerCase();
}

function matchesAllowlist(raw: string, identity: { hcaId: string; email: string }): boolean {
  const entries = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const email = identity.email.toLowerCase();
  const domain = email.split("@")[1];
  return entries.some(
    (e) => e === identity.hcaId.toLowerCase() || e === email || (domain && e === domain),
  );
}

// Who may sign in to the Wizard at all. Unset means open to anyone with a
// Hack Club Auth account — an HCA account is general Hack Club identity, not a
// vetted "runs a YSWS program" role, so populate this before a real launch
// rather than trusting HCA login alone.
export function isAllowed(identity: { hcaId: string; email: string }): boolean {
  const raw = (process.env.PIXIE_WIZARD_ALLOWLIST ?? "").trim();
  if (!raw) return true;
  return matchesAllowlist(raw, identity);
}

// Who may create a new hosted program. Creating a program claims Slack
// channels and stands up a tenant on shared Core, so it is invite-only:
// unset PIXIE_WIZARD_CREATOR_ALLOWLIST means nobody. Signing in, being added
// as a helper, and managing a program you already own are unaffected.
export function isCreatorAllowed(identity: { hcaId: string; email: string }): boolean {
  const raw = (process.env.PIXIE_WIZARD_CREATOR_ALLOWLIST ?? "").trim();
  if (!raw) return false;
  return matchesAllowlist(raw, identity);
}
