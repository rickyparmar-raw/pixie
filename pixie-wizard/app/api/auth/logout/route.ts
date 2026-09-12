import { NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/session";

// POST-only, deliberately: a GET route that clears the session is a classic
// Next.js <Link> footgun. Link prefetches its href's RSC payload the instant
// it scrolls into view, and prefetching this GET handler would silently log
// the visitor out before they ever clicked anything — see the sidebar's
// logout control in DashboardShell, now a <form method="post"> for exactly
// this reason. Actions with side effects must never sit behind a plain GET.
export async function POST() {
  await clearSessionCookie();
  return NextResponse.redirect(`${process.env.BASE_URL}/`);
}
