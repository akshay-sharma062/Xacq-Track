"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Triggers a Meta ads pull for the client (spec 5.7) — the real Marketing API
 * when a token is set, the deterministic fixture when it isn't. Then refreshes
 * the account cards + reports.
 */
export function PullButton({ clientId, simulate }: { clientId: string; simulate: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setOut(null);
    const r = await fetch("/api/meta/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, simulate }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setOut(`pulled ${j.ads ?? 0} ads, ${j.spendRows ?? 0} spend rows${j.simulated ? " (simulated)" : ""}`);
      router.refresh();
    } else {
      setOut(j.error ?? `error ${r.status}`);
    }
  }

  return (
    <div>
      <button className="btn primary" onClick={run} disabled={busy}>
        {busy ? "Pulling…" : simulate ? "Simulate pull" : "Pull from Meta"}
      </button>
      {out ? <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>{out}</div> : null}
    </div>
  );
}
