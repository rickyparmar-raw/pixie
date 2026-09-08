"use client";

import { useState } from "react";
import { hostedIncidentAction, hostedIncidentNotify } from "@/app/wizard/hostedActions";
import { btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

const declareInput = "w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-text placeholder:text-text-muted focus:border-brand focus:outline-none";

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
            setResult(cands.length === 0 ? "No bursts in the last hour." : `Found ${cands.length} candidate${cands.length === 1 ? "" : "s"} below.`);
          }
        }}
        className={btnPrimary}
      >
        {busy ? "Scanning…" : "Scan for bursts"}
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
          <button disabled={busy} onClick={() => setShowDeclare(true)} className={btnPrimary}>Declare incident</button>
        )}
        {status !== "dismissed" && status !== "resolved" && (
          <button disabled={busy} onClick={() => act("dismissed")} className={btnQuiet}>Dismiss</button>
        )}
        {status === "confirmed" && (
          <button disabled={busy} onClick={() => act("resolved")} className={btnQuiet}>Resolve</button>
        )}
        <button disabled={busy} onClick={() => act("announcement")} className={btnQuiet}>Draft announcement</button>
      </div>

      {showDeclare && (
        <div className="max-w-xl space-y-2 border-l-2 border-brand/60 pl-4">
          <p className="text-xs text-text-muted">Declaring makes this the active incident of record.</p>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Internal description (organizers only)" rows={2} className={declareInput} />
          <textarea value={publicMessage} onChange={(e) => setPublicMessage(e.target.value)} placeholder="What Pixie tells matching askers instead of opening a ticket (optional; a safe default is used otherwise)" rows={2} className={declareInput} />
          <div className="flex gap-2">
            <button disabled={busy} onClick={() => act("declare", { description, publicMessage })} className={btnPrimary}>Confirm declare</button>
            <button disabled={busy} onClick={() => setShowDeclare(false)} className={btnQuiet}>Cancel</button>
          </div>
        </div>
      )}

      {status === "resolved" && <NotifyAffectedButton incidentId={incidentId} />}

      {error && <p className="border-l-2 border-brand/60 pl-3 text-sm text-brand">{error}</p>}
      {draft && (
        <div className="max-w-xl border-l-2 border-line pl-4 text-sm text-text">
          <p className="text-xs text-text-muted">Draft. A human posts this, never Pixie.</p>
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
    <div>
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
          setMessage(`Notified ${data.notified ?? 0} thread${(data.notified ?? 0) === 1 ? "" : "s"}${data.failed ? ` (${data.failed} failed, safe to retry)` : ""}.`);
        }}
        className={btnPrimary}
      >
        {busy ? "Notifying…" : "Notify affected users"}
      </button>
      {message && <p className="mt-2 text-xs text-text-muted">{message}</p>}
      {error && <p className="mt-2 text-xs text-brand">{error}</p>}
    </div>
  );
}
