"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Test button" per platform (spec 6: "every platform has a test button that
 * sends a fake event and shows where it landed"). Replays the platform's
 * saved sample payload through the real ingest pipeline and reports where it
 * landed.
 */
export function TestButton({ platform, clientId }: { platform: string; clientId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setResult(null);
    const r = await fetch("/api/integrations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, clientId }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setResult(
        `landed: ${j.events ?? 0} event(s), ${j.payments ?? 0} payment(s), ` +
          `${j.capiQueued ?? 0} CAPI · leads [${(j.leadIds ?? []).join(", ") || "—"}]`
      );
      router.refresh();
    } else {
      setResult(j.error ?? `error ${r.status}`);
    }
  }

  return (
    <div style={{ textAlign: "right", maxWidth: 260 }}>
      <button className="btn sm" onClick={run} disabled={busy}>
        {busy ? "Sending…" : "Send test event"}
      </button>
      {result ? (
        <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
          {result}
        </div>
      ) : null}
    </div>
  );
}
