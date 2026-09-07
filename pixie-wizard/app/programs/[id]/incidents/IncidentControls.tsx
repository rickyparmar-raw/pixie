"use client";

import { useState } from "react";
import { hostedIncidentAction } from "@/app/wizard/hostedActions";

export function IncidentDetectButton({ programId }: { programId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          const res = await hostedIncidentAction({ programId, action: "detect" });
          setBusy(false);
          if (!res.ok) setResult(`Error: ${res.error}`);
          else {
            const cands = (res.data as { candidates?: unknown[] })?.candidates ?? [];
            setResult(cands.length === 0 ? "No bursts in the last hour." : `Found ${cands.length} candidate${cands.length === 1 ? "" : "s"} — listed below.`);
          }
        }}
        className="rounded-md bg-brand px-4 py-2 font-heading text-sm text-white hover:bg-brand-dim disabled:opacity-60"
      >
        {busy ? "Scanning…" : "Scan last hour for bursts"}
      </button>
      {result && <p className="mt-2 text-sm text-text-muted">{result}</p>}
    </div>
  );
}

export function IncidentControls({ programId, incidentId, status }: { programId: string; incidentId: number; status: string }) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError(null);
    const res = await hostedIncidentAction({ programId, incidentId, action, ...extra });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Action failed.");
      return;
    }
    if (action === "announcement") {
      setDraft((res.data as { draft?: string })?.draft ?? null);
    } else {
      window.location.reload();
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {status !== "confirmed" && (
          <button disabled={busy} onClick={() => act("confirmed")} className="rounded-md bg-brand px-3 py-2 font-heading text-xs text-white hover:bg-brand-dim disabled:opacity-60">Confirm</button>
        )}
        {status !== "dismissed" && (
          <button disabled={busy} onClick={() => act("dismissed")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Dismiss</button>
        )}
        {status !== "resolved" && (
          <button disabled={busy} onClick={() => act("resolved")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Resolve</button>
        )}
        <button disabled={busy} onClick={() => act("announcement")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Draft announcement</button>
      </div>
      {error && <p className="rounded-md border border-brand/40 bg-brand/10 px-3 py-2 text-sm text-brand">{error}</p>}
      {draft && (
        <div className="rounded-md border border-line bg-panel-2 p-3 text-sm text-text">
          <p className="font-heading text-xs uppercase tracking-[0.2em] text-text-muted">draft — a human posts this, never Pixie</p>
          <p className="mt-2 whitespace-pre-wrap">{draft}</p>
        </div>
      )}
    </div>
  );
}
