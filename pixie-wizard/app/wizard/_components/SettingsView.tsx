import type { PixieTrialRow } from "@/lib/types";

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  active: { label: "active", tone: "text-mint" },
  paused: { label: "paused", tone: "text-tang" },
  failed: { label: "failed", tone: "text-brand" },
  deleted: { label: "deleted", tone: "text-text-muted" },
};

function daysRemaining(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}

export function SettingsView({ trial }: { trial: PixieTrialRow }) {
  const status = STATUS_COPY[trial.status] ?? { label: trial.status, tone: "text-text" };
  const days = daysRemaining(trial.expires_at);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <p className={`font-heading text-xs uppercase tracking-[0.2em] ${status.tone}`}>
        {status.label}
      </p>
      <h1 className="font-heading mt-3 text-2xl text-text">{trial.bot_name || trial.program_name}</h1>
      <p className="mt-2 text-sm text-text-muted">
        {trial.program_name} in {trial.slack_workspace_name ?? "the Hack Club workspace"}
      </p>

      <dl className="mt-8 space-y-4 rounded-lg border border-line bg-panel p-6 text-sm">
        {trial.status === "active" && days !== null && (
          <Row label="Trial ends">
            {days > 0 ? `in ${days} day${days === 1 ? "" : "s"}` : "today"}
          </Row>
        )}
        {trial.status === "paused" && trial.reclaim_deadline && (
          <Row label="Kept until">{new Date(trial.reclaim_deadline).toLocaleDateString()}</Row>
        )}
        <Row label="Help channel">
          {trial.channels?.helpChannel ? `#${trial.channels.helpChannel.name}` : "—"}
        </Row>
        <Row label="FAQ channels">
          {trial.channels?.faqChannels?.length
            ? trial.channels.faqChannels.map((c) => `#${c.name}`).join(", ")
            : "none"}
        </Row>
        <Row label="Doc sources">{trial.sources.length}</Row>
        <Row label="Last deploy">{trial.last_deploy_status ?? "—"}</Row>
      </dl>

      {trial.status === "paused" && (
        <p className="mt-6 text-sm text-text-muted">
          Your trial window ended. It's kept as-is for a week in case you want to extend
          it — reach out and we'll sort it out.
        </p>
      )}
      {trial.status === "failed" && (
        <p className="mt-6 text-sm text-text-muted">
          Something went wrong provisioning this trial. Reach out and we'll help sort it
          out — nothing you did wrong on your end.
        </p>
      )}

      <p className="mt-8 text-xs text-text-muted">
        Editing doc sources, rotating your LLM key, and changing channels from here is
        coming soon — for now, reach out if you need any of that changed.
      </p>

      <a href="/api/auth/logout" className="mt-8 inline-block text-sm text-text-muted underline">
        Sign out
      </a>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line pb-3 last:border-0 last:pb-0">
      <dt className="text-text-muted">{label}</dt>
      <dd className="text-right text-text">{children}</dd>
    </div>
  );
}
