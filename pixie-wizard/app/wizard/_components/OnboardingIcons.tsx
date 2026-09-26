// Icon set for the onboarding wizard (stepper, drop zone, source rows, preview
// panel, buttons). One family: the line marks are drawn on a 24-unit grid with
// a 2-unit stroke so they keep the same weight at 1x, and square caps keep the
// pixel feel of the reference. The marks that are not square — the drop-file
// page, the sparkle, the Docs page, the helpers group, and the four brand marks
// — carry their own viewBox sized to the mark's real aspect and letterbox inside
// the square element box, so `size` is always the box edge and a brand mark is
// never stretched to fill it.
import type { ReactNode } from "react";
import {
  PixelIconArrowLeft,
  PixelIconArrowRight,
  PixelIconCheck,
  PixelIconClose,
  PixelIconDropFile,
  PixelIconGitHub,
  PixelIconGoogleDoc,
  PixelIconMarkdown,
  PixelIconNotion,
  PixelIconSparkle,
  PixelIconStorage,
  PixelIconWarning,
} from "./PixelIcons";

// These shared marks now draw the 1-bit pixel sprites (PixelIcons.tsx). Callers
// still pass the sizes the old line icons used; snap them to a whole multiple
// of the 16px sprite grid so every pixel stays square.
function pixelSize(size: number): number {
  if (size <= 24) return 16;
  if (size <= 40) return 32;
  return 48;
}


export type OnbIconProps = { size?: number; className?: string };

const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "square",
  strokeLinejoin: "round",
} as const;

/** Page background, used to knock shapes out of the filled marks. */
const INK = "#0f1211";
/** Notion's inner page reads darker than either surface the mark sits on. */
const SHEET = "#0a0d0b";
const DOC_BLUE = "#4285F4";
const DOC_BLUE_FOLD = "#244fb1";

function Glyph({
  size,
  className,
  viewBox,
  children,
}: OnbIconProps & { viewBox: string; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function OnbIconProgram({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 24">
      <rect {...LINE} x="3" y="2" width="18" height="20" rx="2.5" />
      <path {...LINE} d="M7 7.5h10M7 12h10M7 16.5h10" />
    </Glyph>
  );
}

export function OnbIconChannels({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 24">
      <g fill="none" stroke="currentColor" strokeWidth="2.6">
        <path d="M9 2.2v19.6M15 2.2v19.6" />
        <path d="M3.2 8.4h17.6M3.2 15.6h17.6" />
      </g>
    </Glyph>
  );
}

export function OnbIconDocs({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 26">
      <path {...LINE} strokeWidth="2.2" d="M1.1 24.4V1.5h13.1l7.9 7.8v15.1z" />
      <path {...LINE} strokeWidth="2.1" d="M7.4 11.6h8.2M7.4 16.8h8.2" />
    </Glyph>
  );
}

/**
 * Three helpers: the two flanking people are drawn as partial arcs so the
 * front figure's head and shoulders own the middle, which is how the reference
 * mark reads at stepper size.
 */
export function OnbIconHelpers({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 22">
      <g {...LINE} strokeWidth={1.45} strokeLinecap="round">
        <path d="M5.15 10.7A3.38 3.38 0 0 1 5.15 4.72" />
        <path d="M18.85 4.72A3.38 3.38 0 0 1 18.85 10.7" />
        <path d="M1.66 19.55A5.64 5.64 0 0 1 7.3 13.91" />
        <path d="M16.7 13.91A5.64 5.64 0 0 1 22.34 19.55" />
        <circle cx="12" cy="6.21" r="3.76" />
        <path d="M6.36 19.55A5.64 5.64 0 0 1 17.64 19.55" />
      </g>
    </Glyph>
  );
}

export function OnbIconLaunch({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 24">
      <g {...LINE} strokeWidth={1.75} strokeLinecap="round">
        <path d="M21.7 1.4C11 3.4 7.6 8.6 12.2 14.8C17.6 11.2 20.6 5.2 21.7 1.4Z" />
        <path d="M8.75 8.82 2.9 9.75 12.12 11.39Z" />
        <path d="M16.83 9.25 12.9 17.6 14.83 12.13Z" />
        <path d="M8.05 17.88A2.5 2.5 0 1 1 6.2 15.99" />
      </g>
      <circle cx="14.4" cy="7" r="1.35" fill="currentColor" />
    </Glyph>
  );
}

export function OnbIconDropFile({ size = 24, className }: OnbIconProps) {
  return <PixelIconDropFile size={pixelSize(size)} className={className} />;
}

export function OnbIconLayers({ size = 24, className }: OnbIconProps) {
  return <PixelIconStorage size={pixelSize(size)} className={className} />;
}

export function OnbIconSparkle({ size = 24, className }: OnbIconProps) {
  return <PixelIconSparkle size={pixelSize(size)} className={className} />;
}

export function OnbIconCheckCircle({ size = 24, className }: OnbIconProps) {
  return <PixelIconCheck size={pixelSize(size)} className={className} />;
}

export function OnbIconArrowRight({ size = 24, className }: OnbIconProps) {
  return <PixelIconArrowRight size={pixelSize(size)} className={className} />;
}

export function OnbIconArrowLeft({ size = 24, className }: OnbIconProps) {
  return <PixelIconArrowLeft size={pixelSize(size)} className={className} />;
}

export function OnbIconClose({ size = 24, className }: OnbIconProps) {
  return <PixelIconClose size={pixelSize(size)} className={className} />;
}

export function OnbIconAlert({ size = 24, className }: OnbIconProps) {
  return <PixelIconWarning size={pixelSize(size)} className={className} />;
}

export function OnbIconSpinner({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 24">
      <path
        d="M12 4a8 8 0 1 1-8 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </Glyph>
  );
}

/**
 * The Notion cube: a light body, the back sheet's top edge showing above the
 * front sheet, and a slab-serif "N" reversed out of the front sheet. The mark
 * deliberately stops at 19.5 of the 24-unit box — the source row and the
 * preview both scale `[data-kind="notion"]` up, and a full-bleed path would
 * overflow that box.
 */
export function OnbIconNotion({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 24 24">
      <rect x="2.25" y="2.25" width="19.5" height="19.5" rx="1.7" fill="currentColor" />
      <g fill={SHEET}>
        <path d="M4.75 3.7h13.4l-.55 2.2H4.75z" />
        <rect x="6.5" y="7.6" width="13.3" height="12.15" rx="1" />
      </g>
      <g fill="currentColor">
        <path d="M8.75 9.9h3.4v.7h-.58v6.8h.58v.7H8.75v-.7h.56v-6.8H8.75z" />
        <path d="M14.4 9.9h3.4v.7h-.57v6.8h.57v.7H14.4v-.7h.57v-6.8H14.4z" />
        <path d="M9.31 9.9h2.26l5.66 8.2h-2.26z" />
      </g>
    </Glyph>
  );
}

export function OnbIconGitHub({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 16 16">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a10.5 10.5 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
      />
    </Glyph>
  );
}

/**
 * The Drive triangle as three rounded parallelogram segments with hairline
 * gaps: the left arm runs past the base and ends in a rounded tip, the right
 * arm is cut flat where the base begins.
 */
export function OnbIconDrive({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0.4 0.2 32.8 30.7">
      <g fill="currentColor">
        <path d="M10.8 4.27A1.5 1.5 0 0 1 14.21 9.73 1.5 1.5 0 0 1 14.34 12.35L5.66 30.15A1.5 1.5 0 0 1 4.38 30.14L0.62 21.87A1.5 1.5 0 0 1 0.74 19.2L9.26 4.3A1.5 1.5 0 0 1 10.8 4.27Z" />
        <path d="M14.5 0A1.5 1.5 0 0 1 21.5 0 1.5 1.5 0 0 1 23.74 1.31L33.26 18.19A1.5 1.5 0 0 1 32.5 19.5H25.5A1.5 1.5 0 0 1 23.26 18.19L13.74 1.31A1.5 1.5 0 0 1 14.5 0Z" />
        <path d="M14.5 22.5A1.5 1.5 0 0 1 32.5 22.5 1.5 1.5 0 0 1 33.27 23.81L29.73 30.19A1.5 1.5 0 0 1 27.5 31.5H9.5A1.5 1.5 0 0 1 8.73 30.19L12.27 23.81A1.5 1.5 0 0 1 14.5 22.5Z" />
      </g>
    </Glyph>
  );
}

/** The Google Docs page: brand blue, cut top-right corner, three white rules. */
export function OnbIconGoogleDoc({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 30 40">
      <path
        fill={DOC_BLUE}
        d="M3 .5h15.5L29.5 11v26a2.5 2.5 0 0 1-2.5 2.5H3A2.5 2.5 0 0 1 .5 37V3A2.5 2.5 0 0 1 3 .5Z"
      />
      <path fill={DOC_BLUE_FOLD} d="M20 3.4 29.5 11 20 11.6Z" />
      <g fill="#ffffff">
        <rect x="8" y="17.3" width="15" height="1.5" />
        <rect x="8" y="22.8" width="14" height="1.5" />
        <rect x="8" y="28.2" width="10" height="1.5" />
      </g>
    </Glyph>
  );
}

/** The Markdown badge: a light plate carrying a heavy "M" and a solid arrow. */
export function OnbIconMarkdown({ size = 24, className }: OnbIconProps) {
  return (
    <Glyph size={size} className={className} viewBox="0 0 43 26">
      <rect x="0.6" y="0.6" width="41.8" height="24.8" rx="2.4" fill="currentColor" />
      <g fill={INK}>
        <path d="M6 19.6V5h5l3.5 5 3.5-5h5v14.6h-4.5V12l-4 4.6-4-4.6v7.6Z" />
        <path d="M30 4.6h3.6v8.3h3.9L31.8 19.9 26 12.9h4Z" />
      </g>
    </Glyph>
  );
}

export type OnbSourceKind = "notion" | "github" | "gdoc" | "markdown";
export type OnbSourceVariant = "row" | "preview";

// Pixel-pack marks (see PixelIcons.tsx), the same in the Docs row and preview.
const SOURCE_ICON: Record<OnbSourceKind, (size: number) => ReactNode> = {
  notion: (size) => <PixelIconNotion size={size} />,
  github: (size) => <PixelIconGitHub size={size} />,
  gdoc: (size) => <PixelIconGoogleDoc size={size} />,
  markdown: (size) => <PixelIconMarkdown size={size} />,
};

/**
 * Mark for a documentation source. Both placements (the Docs source row and
 * the "What Pixie will know" preview) use the same pixel sprite; `variant` is
 * kept so callers can diverge again without a signature change.
 */
export function sourceKindIcon(kind: OnbSourceKind, _variant: OnbSourceVariant): ReactNode {
  // 32px = 2x the 16px sprite grid, so every pixel stays square.
  return SOURCE_ICON[kind](32);
}
