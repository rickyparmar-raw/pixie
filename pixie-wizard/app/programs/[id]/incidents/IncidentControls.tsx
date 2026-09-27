"use client";

import { useActionState, useState } from "react";
import { hostedIncidentAction, hostedIncidentNotify, hostedManualIncident } from "@/app/wizard/hostedActions";
import { inputClass, labelClass, btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";
import { Notice } from "@/app/_components/DashboardShell";
import { IconRadar, IconSiren, IconExit, IconCheck, IconChat, IconBell } from "@/app/_components/icons";

export function IncidentDetectButton({ programId }: { programId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          setError(null);
          const res = await hostedIncidentAction({ programId, action: "detect" });
          setBusy(false);
          if (!res.ok) setError(res.error ?? "Incident scan failed.");
          else {
            const cands = (res.data as { candidates?: unknown[] })?.candidates ?? [];
            setResult(cands.length === 0 ? "No bursts in the last hour." : `Found ${cands.length} candidate${cands.length === 1 ? "" : "s"} below.`);
          }
        }}
        className={btnPrimary}
        aria-label={busy ? "Scanning for bursts" : "Scan for bursts"}
      >
        <IconRadar size={16} />
        {/* The full label needs ~180px of the header row, which squeezes the
            page description on a phone; the short form keeps the same name. */}
        <span className="sm:hidden">{busy ? "Scanning" : "Scan"}</span>
        <span className="hidden sm:inline">{busy ? "Scanning…" : "Scan for bursts"}</span>
      </button>
      {result && <p className="mt-2 max-w-[18rem] text-xs text-text-muted">{result}</p>}
      {error && (
        <div className="mt-2 max-w-[18rem]">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}

export function ManualIncidentForm({ programId }: { programId: string }) {
  const [state, formAction] = useActionState(hostedManualIncident, { error: null });
  return (
    <form action={formAction} className="pixie-panel max-w-2xl space-y-4 p-4">
      <input type="hidden" name="programId" value={programId} />
      <div>
        <p className="pixie-eyebrow flex items-center gap-2 text-text-muted"><span className="pixie-mark" aria-hidden="true" />Declare an incident</p>
        <p className="mt-2 text-[13px] text-text-muted">Pixie immediately uses this to answer related questions until you resolve it.</p>
      </div>
      <label className="block"><span className={labelClass}>Title</span><input name="title" required placeholder="Acme site is currently down" className={inputClass} /></label>
      <label className="block"><span className={labelClass}>What&apos;s happening</span><textarea name="description" rows={2} placeholder="The site is returning errors for members." className={`${inputClass} resize-y`} /></label>
      <label className="block"><span className={labelClass}>Message Pixie tells members</span><textarea name="publicMessage" required rows={2} placeholder="The Acme site is currently down — the team is on it." className={`${inputClass} resize-y`} /></label>
      <button type="submit" className={btnPrimary}><IconSiren size={16} />Declare incident</button>
      {state.error && <Notice tone="error">{state.error}</Notice>}
    </form>
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
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {status === "candidate" && !showDeclare && (
          <button disabled={busy} onClick={() => setShowDeclare(true)} className={btnPrimary}>
            <IconSiren size={16} />
            Declare incident
          </button>
        )}
        {status !== "dismissed" && status !== "resolved" && (
          <button disabled={busy} onClick={() => act("dismissed")} className={btnQuiet}>
            <IconExit size={16} />
            Dismiss
          </button>
        )}
        {status === "confirmed" && (
          <button disabled={busy} onClick={() => act("resolved")} className={btnQuiet}>
            <IconCheck size={16} />
            Resolve
          </button>
        )}
        <button disabled={busy} onClick={() => act("announcement")} className={btnQuiet}>
          <IconChat size={16} />
          Draft announcement
        </button>
      </div>

      {showDeclare && (
        <div className="pixie-panel max-w-2xl space-y-3 p-4">
          <p className="text-[13px] text-text-muted">Declaring makes this the active incident of record.</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Internal description (organizers only)"
            rows={2}
            aria-label="Internal description"
            className={`${inputClass} resize-y`}
          />
          <textarea
            value={publicMessage}
            onChange={(e) => setPublicMessage(e.target.value)}
            placeholder="What Pixie tells matching askers instead of opening a ticket (optional; a safe default is used otherwise)"
            rows={2}
            aria-label="Public message"
            className={`${inputClass} resize-y`}
          />
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => act("declare", { description, publicMessage })} className={btnPrimary}>
              <IconSiren size={16} />
              Confirm declare
            </button>
            <button disabled={busy} onClick={() => setShowDeclare(false)} className={btnQuiet}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {status === "resolved" && <NotifyAffectedButton incidentId={incidentId} />}

      {error && <Notice tone="error">{error}</Notice>}
      {draft && (
        <div className="pixie-panel-raised max-w-2xl p-4">
          <p className="pixie-eyebrow flex items-center gap-2 text-text-muted">
            <span className="pixie-mark" aria-hidden="true" />
            Draft · a human posts this, never Pixie
          </p>
          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-text">{draft}</p>
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
        <IconBell size={16} />
        {busy ? "Notifying…" : "Notify affected users"}
      </button>
      {message && <p className="mt-2 max-w-[24rem] text-xs text-text-muted">{message}</p>}
      {error && (
        <div className="mt-2 max-w-[24rem]">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}
