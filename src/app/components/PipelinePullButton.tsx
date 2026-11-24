"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Pipeline "Pull now" button (the user's second ask: a manual force-pull
 * affordance, not just auto-refresh). POSTs `/api/meta/refresh` with
 * `force:true` for THIS pipeline's client — a real Meta pull of the client's
 * account(s) that bypasses the 5-min auto throttle.
 *
 * Client-side 90 s cap (same bound as the DataPreloader): the request is
 * aborted at the bound; the server KEEPS the pull running in the background
 * (its own MAX_PULL_MS cap), so the data lands on the next refresh and this
 * button never holds the page open. On a clean pull, `router.refresh()`
 * re-renders the server component with the fresh numbers.
 */
export function PipelinePullButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "pulling" | "done" | "note">("idle");
  const [msg, setMsg] = useState<string>("");
  const inFlight = useRef(false);
  const MAX_WAIT_MS = 90_000;

  const doPull = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState("pulling");
    const controller = new AbortController();
    const capTimer = setTimeout(() => controller.abort(), MAX_WAIT_MS);
    try {
      const r = await fetch("/api/meta/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientId, force: true }),
        signal: controller.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (j.runningInBackground) {
        setMsg(j.reason ?? "pull is running in the background — refresh again in a moment");
        setState("note");
      } else if (j.error) {
        setMsg(j.error);
        setState("note");
      } else if (j.pulled && j.failed) {
        setMsg(Array.isArray(j.errors) ? j.errors.join(" · ") : "pull failed — retry");
        setState("note");
      } else if (j.pulled) {
        setMsg("pulled");
        setState("done");
      } else {
        setMsg(j.reason ?? "nothing to pull");
        setState("note");
      }
      void router.refresh();
    } catch {
      setMsg("pull request interrupted (90 s cap) — it continues in the background");
      setState("note");
    } finally {
      clearTimeout(capTimer);
      inFlight.current = false;
      // Clear the transient note after a few seconds (the page stays usable).
      setTimeout(() => setState((s) => (s === "done" || s === "note" ? "idle" : s)), 4000);
    }
  };

  useEffect(() => {
    setState("idle");
  }, [clientId]);

  return (
    <button
      className="btn sm"
      onClick={() => void doPull()}
      disabled={state === "pulling"}
      style={{ opacity: state === "pulling" ? 0.7 : 1 }}
      title={`Force a live Meta pull for this client's ad account(s) — bypasses the 5-min auto-refresh throttle`}
    >
      {state === "pulling" ? "Pulling from Meta…" : state === "done" ? "✓ Pulled" : "Pull now"}
      {state === "note" && msg ? (
        <span className="faint" style={{ marginLeft: 8, fontSize: 11 }}>{msg}</span>
      ) : null}
    </button>
  );
}
