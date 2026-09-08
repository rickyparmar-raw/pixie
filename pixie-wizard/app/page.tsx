import Link from "next/link";

// Landing. One idea, told once: a real support request moving through Pixie —
// question, grounded answer, ticket, human, resolution, better docs. That
// journey is the visual spine of the page. No browser chrome, no terminal,
// no traffic lights. Server component.

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2">
      <span className="size-3 rounded-[3px] bg-brand" aria-hidden />
      <span className="font-mono text-xs uppercase tracking-[0.2em] text-text-muted">Pixie</span>
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="font-mono text-xs uppercase tracking-[0.18em] text-text-muted">{children}</p>;
}

const RUN_TONE: Record<string, string> = {
  muted: "bg-text-muted",
  brand: "bg-brand",
  mint: "bg-mint",
  tang: "bg-tang",
};

// One stage on the horizontal support-signal rail.
function Stage({
  n,
  title,
  body,
  detail,
  tone = "muted",
  last,
}: {
  n: number;
  title: string;
  body: string;
  detail: string;
  tone?: keyof typeof RUN_TONE;
  last?: boolean;
}) {
  return (
    <li className="relative sm:pr-5">
      {!last && (
        <span className="absolute left-3 right-0 top-[5px] hidden h-px bg-line sm:block" aria-hidden />
      )}
      <span className={`relative z-10 block size-2.5 rounded-full ring-4 ring-ink ${RUN_TONE[tone]}`} aria-hidden />
      <div className="mt-4">
        <span className="font-mono text-[11px] tabular-nums text-text-muted/50">{String(n).padStart(2, "0")}</span>
        <h3 className="font-heading mt-0.5 text-sm text-text">{title}</h3>
        <p className="mt-2 text-xs leading-relaxed text-text-muted">{body}</p>
        <p className="mt-3 inline-flex rounded-[var(--radius)] border border-line px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
          {detail}
        </p>
      </div>
    </li>
  );
}

export default function LandingPage() {
  const devBypass = process.env.NODE_ENV !== "production";

  return (
    <main className="mx-auto max-w-7xl px-6 lg:px-10">
      {/* ---- Hero (full viewport) ---------------------------------- */}
      <section className="relative -mx-6 flex min-h-svh flex-col justify-center px-6 py-24 lg:-mx-10 lg:px-10">
        <div className="dot-grid dot-grid-fade pointer-events-none absolute inset-0" aria-hidden />
        <div className="relative grid items-center gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16">
          <div>
            <Wordmark />
            <h1 className="font-heading mt-7 max-w-xl text-[2.9rem] font-semibold leading-[1.04] tracking-tight text-text sm:text-[3.5rem]">
              Support that knows your program.
            </h1>
            <p className="mt-6 max-w-md text-[15px] leading-relaxed text-text-muted">
              Pixie answers from your program&apos;s docs, pulls in a person when a
              question needs one, and turns what it couldn&apos;t answer into better
              docs.
            </p>

            {/* the spine, in miniature */}
            <div className="mt-7 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-text-muted">
              <span className="size-1.5 rounded-full bg-text-muted" aria-hidden /> question
              <span className="h-px w-4 bg-line" aria-hidden />
              <span className="size-1.5 rounded-full bg-brand" aria-hidden /> answer
              <span className="h-px w-4 bg-line" aria-hidden />
              <span className="size-1.5 rounded-full bg-tang" aria-hidden /> human
              <span className="h-px w-4 bg-line" aria-hidden />
              <span className="size-1.5 rounded-full bg-mint" aria-hidden /> resolved
            </div>

            <div className="mt-8 flex items-center gap-3">
              <Link href="/api/auth/login" className="pixie-button pixie-button-primary min-h-10 px-5 text-sm">
                Set up Pixie
              </Link>
              {devBypass && (
                <Link href="/api/auth/dev-login" className="pixie-button pixie-button-quiet min-h-10 px-4">
                  Dev sign-in
                </Link>
              )}
            </div>
            <p className="mt-4 font-mono text-[11px] text-text-muted">
              Built for Hack Club programs · Runs in Slack
            </p>
          </div>

          {/* One real support moment. */}
          <div className="pixie-panel">
            <div className="flex items-center gap-2 border-b border-line px-5 py-3">
              <span className="size-1.5 rounded-full bg-brand" aria-hidden />
              <span className="font-mono text-xs text-text-muted">#pixl-help</span>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div className="text-sm">
                <span className="text-text-muted">sam</span>
                <p className="mt-1 text-text">Do I need my repo public?</p>
              </div>
              <div className="border-l-2 border-brand/50 pl-4 text-sm">
                <span className="text-brand">Pixie</span>
                <p className="mt-1 leading-relaxed text-text">
                  Yes. Software submissions need a public, open-source repository.
                </p>
                <p className="mt-2.5 font-mono text-[11px] text-text-muted">↗ Submission Guidelines</p>
              </div>
              <div className="text-sm">
                <span className="text-text-muted">sam</span>
                <p className="mt-1 text-text">Mine&apos;s private for a sponsor reason. Any exception?</p>
              </div>
              <div className="border-l-2 border-tang/50 pl-4 text-sm">
                <span className="text-text-muted">Pixie</span>
                <p className="mt-1 leading-relaxed text-text">Passing this to an organizer.</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-5 py-3 font-mono text-[11px] text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-brand" aria-hidden /> answered
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-tang" aria-hidden /> #184 claimed · Cal
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-mint" aria-hidden /> resolved · 6m
              </span>
            </div>
          </div>
        </div>

        {/* scroll cue into the story */}
        <div className="absolute inset-x-6 bottom-8 flex items-center gap-2 font-mono text-[11px] text-text-muted/60 lg:inset-x-10">
          <span className="h-px w-6 bg-line" aria-hidden />
          the run ↓
        </div>
      </section>

      {/* ---- The run ----------------------------------------------- */}
      <section className="border-t border-line py-16 sm:py-20">
        <SectionLabel>The run</SectionLabel>
        <div className="mt-3 max-w-xl">
          <h2 className="font-heading text-[1.75rem] font-semibold leading-tight text-text text-balance">
            One request, start to finish.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-text-muted">
            Every question takes the same path. Pixie handles most of it; your team
            steps in exactly where judgment is needed.
          </p>
        </div>

        <ol className="mt-12 grid gap-x-2 gap-y-10 sm:grid-cols-5">
          <Stage n={1} title="Question" body="Someone asks in your help channel. No command, no form." detail="#pixl-help" />
          <Stage n={2} title="Grounded answer" tone="brand" body="Pixie answers from your approved docs, with the source attached." detail="↗ Submission Guidelines" />
          <Stage n={3} title="Ticket" tone="tang" body="Judgment call, or Pixie isn't sure: a ticket opens and routes by expertise." detail="#184 · waiting_for_helper" />
          <Stage n={4} title="A person" body="An organizer claims, replies, resolves. The asker just sees a normal reply." detail="Cal claimed · 2m" />
          <Stage n={5} title="Better docs" tone="mint" body="Recurring misses become review candidates. Approve once; it grounds future answers." detail="2 candidates" last />
        </ol>
      </section>

      {/* ---- Isolation ------------------------------------------------ */}
      <section className="border-t border-line py-16 sm:py-20">
        <SectionLabel>Isolation</SectionLabel>
        <div className="mt-3 grid gap-8 md:grid-cols-[1fr_1.4fr] md:items-start md:gap-16">
          <div>
            <h2 className="font-heading text-[1.75rem] font-semibold leading-tight text-text text-balance">
              One Pixie. Separate programs.
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-text-muted">
              Every program keeps its own docs, tickets, helpers and channels. The
              lanes never cross.
            </p>
          </div>
          <div className="grid grid-cols-3 gap-4 min-[420px]:gap-6 sm:gap-8">
            {["Pixl", "Hardwire", "Athena"].map((p, i) => (
              <div key={p}>
                <div className="flex items-center gap-2">
                  <span className={`size-2 rounded-full ${i === 0 ? "bg-brand" : "bg-text-muted"}`} aria-hidden />
                  <p className={`truncate text-sm ${i === 0 ? "text-text" : "text-text-muted"}`}>{p}</p>
                </div>
                <ul className="mt-3 space-y-2 border-l border-line pl-4 font-mono text-[11px] text-text-muted">
                  <li>sources</li>
                  <li>tickets</li>
                  <li>helpers</li>
                  <li>channels</li>
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Dashboard --------------------------------------------- */}
      <section className="border-t border-line py-16 sm:py-20">
        <SectionLabel>Dashboard</SectionLabel>
        <div className="mt-3 grid gap-8 md:grid-cols-[1fr_1.4fr] md:items-start md:gap-16">
          <div>
            <h2 className="font-heading text-[1.75rem] font-semibold leading-tight text-text text-balance">
              Run it from one place.
            </h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-text-muted">
              Support health, what needs attention, ticket state and knowledge. One
              screen per program.
            </p>
          </div>
          <div className="pixie-panel space-y-5 p-5">
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4 border-b border-line pb-4">
              {[
                ["Questions", "142", "text-text"],
                ["Pixie answered", "98", "text-text"],
                ["Escalated", "31", "text-brand"],
                ["Resolved", "120", "text-mint"],
              ].map(([label, value, tone]) => (
                <div key={label}>
                  <p className={`font-mono text-xl tabular-nums ${tone}`}>{value}</p>
                  <p className="mt-1 text-xs text-text-muted">{label}</p>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              {[
                ["Pixie answered", 58, "bg-mint"],
                ["Waiting for a helper", 14, "bg-tang"],
                ["Assigned", 9, "bg-text-muted"],
              ].map(([label, value, tone]) => (
                <div key={label as string} className="grid grid-cols-[10rem_1fr_1.75rem] items-center gap-3 text-xs">
                  <span className="text-text-muted">{label}</span>
                  <span className="h-1.5 overflow-hidden rounded-full bg-line/60">
                    <span className={`block h-full rounded-full ${tone}`} style={{ width: `${(Number(value) / 58) * 100}%` }} />
                  </span>
                  <span className="text-right font-mono text-text">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ---- CTA --------------------------------------------------- */}
      <section className="border-t border-line py-16 text-center sm:py-24">
        <h2 className="font-heading text-2xl font-semibold text-text">Run support from one place.</h2>
        <div className="mt-6 flex justify-center">
          <Link href="/api/auth/login" className="pixie-button pixie-button-primary min-h-10 px-5 text-sm">
            Set up Pixie
          </Link>
        </div>
        <p className="mt-4 font-mono text-[11px] text-text-muted">
          Sign in with Hack Club Auth · no bot token, no model key
        </p>
      </section>
    </main>
  );
}
