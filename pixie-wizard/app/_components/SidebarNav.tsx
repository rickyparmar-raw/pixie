"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType } from "react";
import {
  IconHome,
  IconGrid,
  IconUsers,
  IconChat,
  IconDoc,
  IconRadar,
  IconAlert,
  IconBars,
  IconLog,
  IconClock,
  IconGear,
} from "./icons";

// Small client island so the sidebar can show which route is active without
// making the whole shell a client component. Just links + usePathname — no
// state, no effects.

type Item = [slug: string, label: string, Icon: ComponentType<{ size?: number; className?: string }>];

const MAIN: Item[] = [
  ["tickets", "Tickets", IconChat],
  ["knowledge", "Knowledge", IconDoc],
  ["gaps", "FAQ gaps", IconAlert],
  ["helpers", "Helpers", IconUsers],
  ["people", "People", IconUsers],
  ["macros", "Macros", IconLog],
  ["analytics", "Analytics", IconBars],
  ["radar", "Support radar", IconRadar],
  ["incidents", "Incidents", IconAlert],
];

const SECONDARY: Item[] = [
  ["audit", "Audit", IconLog],
  ["retention", "Retention", IconClock],
  ["settings", "Settings", IconGear],
];

function isActive(pathname: string, href: string, exact: boolean): boolean {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  href,
  label,
  exact,
  muted,
  Icon,
}: {
  href: string;
  label: string;
  exact: boolean;
  muted?: boolean;
  Icon: ComponentType<{ size?: number; className?: string }>;
}) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 border-l-2 py-1.5 pl-3 text-[13px] transition-colors ${
        active
          ? "border-brand text-text"
          : `border-transparent hover:text-text ${muted ? "text-text-muted/70" : "text-text-muted"}`
      }`}
    >
      <Icon size={14} className="shrink-0" />
      {label}
    </Link>
  );
}

export function WorkspaceNav() {
  return (
    <nav className="mt-3 space-y-0.5">
      <NavLink href="/overview" label="Overview" exact Icon={IconHome} />
      <NavLink href="/programs" label="Programs" exact Icon={IconGrid} />
      <NavLink href="/people" label="People & access" exact Icon={IconUsers} />
    </nav>
  );
}

function MobileNavLink({ href, label, exact }: { href: string; label: string; exact: boolean }) {
  const pathname = usePathname();
  const active = isActive(pathname ?? "", href, exact);
  return (
    <Link
      href={href}
      prefetch={false}
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
        <NavLink href={base} label="Overview" exact Icon={IconHome} />
        {MAIN.map(([slug, label, Icon]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} Icon={Icon} />
        ))}
      </nav>
      <nav className="mt-4 space-y-0.5">
        {SECONDARY.map(([slug, label, Icon]) => (
          <NavLink key={slug} href={`${base}/${slug}`} label={label} exact={false} Icon={Icon} muted />
        ))}
      </nav>
    </>
  );
}
