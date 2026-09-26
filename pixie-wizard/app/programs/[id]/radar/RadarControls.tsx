"use client";

import { Select } from "@/app/_components/Select";

import { useState } from "react";
import { hostedRadarAction } from "@/app/wizard/hostedActions";
import { btnQuiet } from "@/app/wizard/_components/formStyles";
import { Notice } from "@/app/_components/DashboardShell";
import { IconRadar } from "@/app/_components/icons";

export function RadarRefreshButton({ programId }: { programId: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  return (
    <div>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setResult(null);
          const res = await hostedRadarAction({ programId, action: "evaluate" });
          setBusy(false);
          if (!res.ok) setResult({ tone: "error", message: `Error: ${res.error}` });
          else {
            const signals = (res.data as { signals?: unknown[] })?.signals ?? [];
            setResult({
              tone: "success",
              message: `Re-checked. ${signals.length} live signal${signals.length === 1 ? "" : "s"}.`,
            });
            window.location.reload();
          }
        }}
        className={btnQuiet}
      >
        <IconRadar size={16} />
        {busy ? "Checking…" : "Refresh"}
      </button>
      {result && (
        <div className="mt-3 w-[22rem] max-w-[70vw]">
          <Notice tone={result.tone}>{result.message}</Notice>
        </div>
      )}
    </div>
  );
}

// Every action on a signal row is quiet. Resolving seven signals is not one
// headline action, so nothing here takes the page's single lime.
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
    <div className="flex flex-wrap items-center gap-2">
      {status !== "acknowledged" && status !== "resolved" && (
        <button disabled={busy} onClick={() => act("acknowledge")} className={btnQuiet}>Acknowledge</button>
      )}
      {status !== "resolved" && (
        <button disabled={busy} onClick={() => act("resolve")} className={btnQuiet}>Resolve</button>
      )}
      {status !== "suppressed" && status !== "resolved" && (
        <>
          <Select name="duration" defaultValue={duration} className="w-[86px]" ariaLabel="Duration" onValueChange={(v) => setDuration(v as "1h" | "24h" | "7d")} options={[{ value: "1h", label: "1h" }, { value: "24h", label: "24h" }, { value: "7d", label: "7d" }]} />
          <button disabled={busy} onClick={() => act("suppress")} className={btnQuiet}>Suppress</button>
        </>
      )}
      {error && (
        <div className="w-full min-w-[16rem] flex-1">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}
