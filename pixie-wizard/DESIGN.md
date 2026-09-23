# Pixie Wizard Design System

## 1. Reference

The visual contract is the published Pixie Wizard prototype at `pixiewiz-lxzqyyjk.manus.space`, inspected on 2026-09-07 at 1440px and through all seven hosted-onboarding stages. This application recreates its control-panel conventions with real Wizard data and server actions.

## 2. Tokens

- Ground: `#0b0e13`; panel: `#10141c`; raised panel: `#131821`; line: `#252d39`.
- Text: `#d7dbe4`; muted: `#717b8d`; dim: `#4e5868`; coral: `#ef5b70`; mint: `#73d4b4`; amber: `#c99b58`.
- Typeface: IBM Plex Mono fallback chain. Headings are 500 weight; labels are 400 weight.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64px. Content is 1040px wide in the onboarding flow and fills the dashboard shell.
- Radius: 6px for fields, buttons, cards, and status badges. Surfaces use borders instead of shadows.

## 3. Layout

- Page ground has a 16px dot grid using a low-opacity 1px radial dot.
- Hosted onboarding has a top identity bar, a seven-stop progress rail, and a 680px form panel.
- Dashboard uses a 226px fixed sidebar, 70px utility bar, and a scrollable content main region.
- At 768px the sidebar becomes horizontal navigation; at 375px forms are single-column and progress labels collapse to step number.

## 4. Type and Motion

- UI type is 12px labels, 13px controls/body, 16px section headings, and 24px page headings.
- Controls transition border and background for 150ms ease. Focus uses a coral outer ring; reduced-motion disables transitions.

## 5. Primitives

- `WizardShell`: brand bar, progress rail, constrained stage panel.
- `Field`, `Select`, and `Toggle`: bordered dark input anatomy with labels and descriptions.
- `Panel`, `MetricCard`, `StatusBadge`, and `DataTable`: dashboard surfaces with border-only separation.
- `DashboardShell`: tenant-scoped sidebar and route content region.

## 6. Accessibility

- Every field has an explicit label, visible focus state, and semantic error text.
- Progress stops are buttons with stage names. Navigation preserves the current form state.
- Interactive color is never the only state signal.

## 7. Accepted Differences

- The prototype uses mock chart data. Wizard charts may only render data returned by Pixie Core and otherwise render an explicit empty state.
- The prototype avatar image is replaced by a URL-backed identity preview until Wizard storage is configured; image bytes are never stored in normal database rows.

## 8. Public landing

- The public route uses graphite `#0e100f`, warm cream `#fffce1`, Pixie lime `#b7ffa3`, evidence yellow `#e8ff38`, and handoff violet `#a78bfa`. It is the technical, dark-mode counterpart to the operational dashboard.
- Reusable primitives are the `button`, eyebrow, ticket card, decision card, dashboard fixture, and helper route node. Fixture labels mirror tickets, analytics, and helpers that Pixie actually has.
- Motion is explanatory: GSAP reveals scenes, pins the evidence decision only on desktop, draws system connectors, and scrubs the kinetic confidence tape. `gsap.matchMedia()` removes pinning and the tape scrub on smaller viewports; reduced motion keeps every scene visible without scrub or parallax.
- Source order follows the support story, real links carry navigation, and color is paired with text status.
