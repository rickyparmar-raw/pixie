"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Small client island so the sidebar can show which route is active without
// making the whole shell a client component. Just links + usePathname — no
// state, no effects.

type Item = [slug: string, label: string];

const MAIN: Item[] = [
  ["tickets", "Tickets"],
  ["knowledge", "Knowledge"],
  ["gaps", "FAQ gaps"],
  ["helpers", "Helpers"],
  ["macros", "Macros"],
  ["analytics", "Analytics"],
  ["radar", "Support radar"],
  ["incidents", "Incidents"],
];

const SECONDARY: Item[] = [
  ["audit", "Audit"],
  ["retention", "Retention"],
  ["settings", "Settings"],
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({ href, label, exact, muted }: { href: string; label: string; exact: boolean; muted?: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`block border-l-2 py-1.5 pl-3 text-[13px] transition-colors ${
        active
          ? "border-brand text-text"
          : `border-transparent hover:text-text ${muted ? "text-text-muted/70" : "text-text-muted"}`
      }`}
    >
      {label}
    </Link>
  );
}

export function WorkspaceNav() {
  return (
    <nav className="mt-3 space-y-0.5">
      <NavLink href="/overview" label="Overview" exact />
      <NavLink href="/programs" label="Programs" exact />
    </nav>
  );
}

function MobileNavLink({ href, label, exact }: { href: string; label: string; exact: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`whitespace-nowrap border-b-2 pb-1.5 text-xs transition-colors ${
        active ? "border-brand text-text" : "border-transparent text-text-muted"
      }`}
    >
      {label}
    </Link>
  );
}

// Shown in the header on narrow viewports where the sidebar is hidden.
export function MobileProgramNav({ programId }: { programId: string }) {
  const base = `/programs/${programId}`;
  return (
    <nav className="flex w-full gap-4 overflow-x-auto lg:hidden">
      <MobileNavLink href={base} label="Overview" exact />
      {[...MAIN, ...SECONDARY].map(([slug, label]) => (
        <MobileNavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} />
      ))}
    </nav>
  );
}

export function ProgramNav({ programId }: { programId: string }) {
  const base = `/programs/${programId}`;
  return (
    <>
      <nav className="mt-2 space-y-0.5">
        <NavLink href={base} label="Overview" exact />
        {MAIN.map(([slug, label]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} />
        ))}
      </nav>
      <nav className="mt-4 space-y-0.5">
        {SECONDARY.map(([slug, label]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} muted />
        ))}
      </nav>
    </>
  );
}
