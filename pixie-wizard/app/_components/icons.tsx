// Small line-icon set for the dashboard shell and cards. One consistent
// style: 16px grid, ~1.6 stroke, rounded joins, no fills except status dots
// (which live elsewhere). Kept together so every icon in the shell reads as
// one family instead of a mix of borrowed sets.
type IconProps = { size?: number; className?: string };

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function IconHome({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M2 7.2 8 2l6 5.2M3.4 6.2V14h9.2V6.2" />
    </svg>
  );
}

export function IconGrid({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <rect {...base} x="2" y="2" width="5" height="5" rx="1" />
      <rect {...base} x="9" y="2" width="5" height="5" rx="1" />
      <rect {...base} x="2" y="9" width="5" height="5" rx="1" />
      <rect {...base} x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

export function IconChat({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M2 3.5h12v7.5H6.4L3 14v-3H2z" />
    </svg>
  );
}

export function IconUsers({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle {...base} cx="6" cy="5.5" r="2.3" />
      <path {...base} d="M1.6 14c.4-2.6 2.2-4 4.4-4s4 1.4 4.4 4" />
      <path {...base} d="M10.6 2c1.2.3 2 1.3 2 2.5s-.8 2.2-2 2.5M12.8 9.6c1.5.3 2.5 1.4 2.9 3.4" />
    </svg>
  );
}

export function IconDoc({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M4 1.6h5.4L12 4.2V14.4H4z" />
      <path {...base} d="M9.4 1.6v2.8H12" />
      <path {...base} d="M6 8h4M6 10.5h4" />
    </svg>
  );
}

export function IconBars({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M3 13.5V8.5M8 13.5V3M13 13.5V6" />
    </svg>
  );
}

export function IconRadar({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle {...base} cx="8" cy="8" r="6" />
      <circle {...base} cx="8" cy="8" r="2.6" />
      <path {...base} d="M8 8 12.4 4.2" />
    </svg>
  );
}

export function IconAlert({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M8 2 14.5 13.5H1.5Z" />
      <path {...base} d="M8 6.3v3.1" />
      <circle cx="8" cy="11.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconLog({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M3 2.5h10v11H3z" />
      <path {...base} d="M5.5 5.5h5M5.5 8h5M5.5 10.5h3" />
    </svg>
  );
}

export function IconClock({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle {...base} cx="8" cy="8" r="6" />
      <path {...base} d="M8 4.6V8l2.6 1.6" />
    </svg>
  );
}

export function IconGear({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle {...base} cx="8" cy="8" r="2.4" />
      <path
        {...base}
        d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1M12.2 12.2l-1.1-1.1M4.9 4.9 3.8 3.8"
      />
    </svg>
  );
}

export function IconSearch({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle {...base} cx="7" cy="7" r="4.6" />
      <path {...base} d="M13.6 13.6 10.4 10.4" />
    </svg>
  );
}

export function IconBell({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M4 6.4a4 4 0 0 1 8 0c0 3 1.2 4 1.8 4.6H2.2C2.8 10.4 4 9.4 4 6.4Z" />
      <path {...base} d="M6.4 13.4a1.8 1.8 0 0 0 3.2 0" />
    </svg>
  );
}

export function IconChevronRight({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M3 8.4 6.2 11.5 13 4" />
    </svg>
  );
}

export function IconHand({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M6 8.5V3.2a1 1 0 0 1 2 0V7" />
      <path {...base} d="M8 7V2.6a1 1 0 0 1 2 0V7" />
      <path {...base} d="M10 7.2V3.6a1 1 0 0 1 2 0V9c0 3-1.8 5-4.6 5-2 0-3-.8-4.2-2.4L1.8 9.2a1.1 1.1 0 0 1 1.7-1.4L5 9.5" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} aria-hidden="true">
      <path {...base} d="M2.5 8h10.2M9 4.4 12.8 8 9 11.6" />
    </svg>
  );
}
