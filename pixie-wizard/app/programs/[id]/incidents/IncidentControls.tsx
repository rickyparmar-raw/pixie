"use client";

import { useState } from "react";
import { hostedIncidentAction, hostedIncidentNotify } from "@/app/wizard/hostedActions";

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
  const [showDeclare, setShowDeclare] = useState(false);
  const [description, setDescription] = useState("");
  const [publicMessage, setPublicMessage] = useState("");

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
        {status === "candidate" && !showDeclare && (
          <button disabled={busy} onClick={() => setShowDeclare(true)} className="rounded-md bg-brand px-3 py-2 font-heading text-xs text-white hover:bg-brand-dim disabled:opacity-60">Declare incident</button>
        )}
        {status !== "dismissed" && status !== "resolved" && (
          <button disabled={busy} onClick={() => act("dismissed")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Dismiss</button>
        )}
        {status === "confirmed" && (
          <button disabled={busy} onClick={() => act("resolved")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Resolve</button>
        )}
        <button disabled={busy} onClick={() => act("announcement")} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Draft announcement</button>
      </div>

      {showDeclare && (
        <div className="space-y-2 rounded-md border border-line bg-panel-2 p-3">
          <p className="font-heading text-xs uppercase tracking-[0.2em] text-text-muted">Declaring makes this the authoritative ACTIVE incident</p>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Internal description (organizers only)" rows={2} className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-text" />
          <textarea value={publicMessage} onChange={(e) => setPublicMessage(e.target.value)} placeholder="What Pixie tells matching askers instead of opening a ticket (optional — a safe default is used otherwise)" rows={2} className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm text-text" />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => act("declare", { description, publicMessage })} className="rounded-md bg-brand px-3 py-2 font-heading text-xs text-white hover:bg-brand-dim disabled:opacity-60">Confirm declare</button>
            <button disabled={busy} onClick={() => setShowDeclare(false)} className="rounded-md border border-line px-3 py-2 font-heading text-xs text-text hover:text-white disabled:opacity-60">Cancel</button>
          </div>
        </div>
      )}

      {status === "resolved" && <NotifyAffectedButton incidentId={incidentId} />}

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

export function NotifyAffectedButton({ incidentId }: { incidentId: number }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-md border border-line bg-panel-2 p-3">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setMessage(null);
          const res = await hostedIncidentNotify({ incidentId });
          setBusy(false);
          if (!res.ok) {
            setError(res.error ?? "Notify failed.");
            return;
          }
          const data = res.data as { notified?: number; failed?: number };
          setMessage(`Notified ${data.notified ?? 0} thread${(data.notified ?? 0) === 1 ? "" : "s"}${data.failed ? ` (${data.failed} failed — safe to retry)` : ""}.`);
        }}
        className="rounded-md bg-brand px-3 py-2 font-heading text-xs text-white hover:bg-brand-dim disabled:opacity-60"
      >
        {busy ? "Notifying…" : "Notify affected users"}
      </button>
      {message && <p className="mt-2 text-xs text-text-muted">{message}</p>}
      {error && <p className="mt-2 text-xs text-brand">{error}</p>}
    </div>
  );
}
