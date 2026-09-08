"use client";

import { useState } from "react";
import { hostedRadarAction } from "@/app/wizard/hostedActions";
import { btnPrimary, btnQuiet } from "@/app/wizard/_components/formStyles";

export function RadarRefreshButton({ programId }: { programId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          const res = await hostedRadarAction({ programId, action: "evaluate" });
          setBusy(false);
          if (!res.ok) setResult(`Error: ${res.error}`);
          else {
            const signals = (res.data as { signals?: unknown[] })?.signals ?? [];
            setResult(`Re-checked. ${signals.length} live signal${signals.length === 1 ? "" : "s"}.`);
            window.location.reload();
          }
        }}
        className={btnQuiet}
      >
        {busy ? "Checking…" : "Refresh"}
      </button>
      {result && <p className="mt-2 text-xs text-text-muted">{result}</p>}
    </div>
  );
}

export function RadarSignalControls({ programId, signalId, status }: { programId: string; signalId: number; status: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState<"1h" | "24h" | "7d">("24h");

  async function act(action: "acknowledge" | "resolve" | "suppress") {
    setBusy(true);
    setError(null);
    const res = await hostedRadarAction({ programId, signalId, action, duration: action === "suppress" ? duration : undefined });
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Action failed.");
      return;
    }
    window.location.reload();
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {status !== "acknowledged" && status !== "resolved" && (
        <button disabled={busy} onClick={() => act("acknowledge")} className={btnQuiet}>Acknowledge</button>
      )}
      {status !== "resolved" && (
        <button disabled={busy} onClick={() => act("resolve")} className={btnPrimary}>Resolve</button>
      )}
      {status !== "suppressed" && status !== "resolved" && (
        <>
          <select value={duration} onChange={(e) => setDuration(e.target.value as "1h" | "24h" | "7d")} className="rounded-md border border-line bg-panel-2 px-2 py-1.5 text-xs text-text">
            <option value="1h">1h</option>
            <option value="24h">24h</option>
            <option value="7d">7d</option>
          </select>
          <button disabled={busy} onClick={() => act("suppress")} className={btnQuiet}>Suppress</button>
        </>
      )}
      {error && <p className="w-full text-xs text-brand">{error}</p>}
    </div>
  );
}
