"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Data Preloader (user ask: "jab tak data full na ho, ek loader show ho").
 *
 * On mount (i.e. EVERY page refresh) + on a 60 s tick, this POSTs
 * `/api/meta/refresh`:
 *   - a SPECIFIC ad-account filter → a REAL Meta pull of that account
 *     (server-side throttled to a 5-min min gap + single-writer locked),
 *   - the all-accounts view → a DB re-read (no fleet-wide pull on auto-refresh).
 *
 * While the call is in flight a FULL-SCREEN preloader overlay is shown
 * ("Pulling fresh data from Meta…", live seconds counter) — the PO never
 * sees half-loaded numbers mid-pull. When it resolves, `router.refresh()`
 * re-renders the server component with the just-pulled data, and a brief
 * "Updated" confirmation flashes before the overlay closes.
 *
 * An overlay that NEVER closes on error: a failed/404 response still
 * dismisses after a short "could not refresh (reason)" note — the page is
 * usable, the stale DB data is still shown (the stamp below explains).
 */
export function DataPreloader({
  adAccount,
  clientId,
  visible = true,
}: {
  adAccount?: string | null;
  clientId?: string | null;
  /** Hide the overlay logic entirely (e.g. a screen without a dashboard). */
  visible?: boolean;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"pulling" | "updated" | "note" | "idle">("idle");
  const [startedAt, setStartedAt] = useState<number>(0);
  const [elapsed, setElapsed] = useState<number>(0);
  const [note, setNote] = useState<string>("");
  const inFlight = useRef(false);
  const adAccountRef = useRef(adAccount);
  const clientIdRef = useRef(clientId);
  adAccountRef.current = adAccount;
  clientIdRef.current = clientId;

  const doPull = useCallback(
    async (manual: boolean) => {
      if (inFlight.current) return; // never parallelize a pull with itself
      inFlight.current = true;
      setStartedAt(Date.now());
      setElapsed(0);
      setPhase("pulling");
      try {
        const r = await fetch("/api/meta/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            adAccount: adAccountRef.current ?? undefined,
            client: clientIdRef.current ?? undefined,
            force: manual,
          }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.error) {
          setNote(`could not refresh — ${j.error}`);
          setPhase("note");
        } else if (j.pulled && j.failed) {
          setNote(`Meta error on ${adAccountRef.current ?? "account"}: ${Array.isArray(j.errors) ? j.errors.join(" · ") : "unknown"}`);
          setPhase("note");
        } else if (j.pulled) {
          setPhase("updated"); // brief confirmation, then dismiss + refresh
        } else {
          setNote(j.reason ? `skipped live pull (${j.reason})` : "refresh ok");
          setPhase(j.reason ? "note" : "updated");
        }
        // Re-render the server component with whatever the pull produced.
        void router.refresh();
      } catch {
        setNote("refresh request failed (network) — showing last known data");
        setPhase("note");
      } finally {
        inFlight.current = false;
      }
    },
    [router]
  );

  // Every page refresh (mount) + 60 s ticks — the "har refresh pr Meta pull" ask.
  useEffect(() => {
    if (!visible) return;
    void doPull(false);
    const id = setInterval(() => void doPull(false), 60_000);
    return () => clearInterval(id);
  }, [doPull, visible]);

  // Live seconds counter while pulling.
  useEffect(() => {
    if (phase !== "pulling") return;
    const id = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [phase, startedAt]);

  // Auto-dismiss "updated"/"note" after 3 s.
  useEffect(() => {
    if (phase !== "updated" && phase !== "note") return;
    const id = setTimeout(() => setPhase("idle"), 3000);
    return () => clearTimeout(id);
  }, [phase]);

  if (phase === "idle" || !visible) return null;

  const showOverlay = phase === "pulling" && elapsed >= 2; // brief pulls: no flash

  return (
    <>
      {/* Full-screen preloader: blocks interaction until the pull lands. */}
      {showOverlay ? (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 100, display: "flex",
            alignItems: "center", justifyContent: "center", flexDirection: "column",
            gap: 14, background: "rgba(10,14,25,0.72)", backdropFilter: "blur(4px)",
          }}
        >
          <div
            style={{
              width: 46, height: 46, borderRadius: "50%",
              border: "4px solid rgba(79,140,255,0.2)", borderTopColor: "#4f8cff",
              animation: "xspin 0.9s linear infinite",
            }}
            aria-hidden
          />
          <div style={{ color: "#dfe6ff", fontSize: 15, fontWeight: 600 }}>
            {adAccount ? `Pulling fresh data from Meta (${adAccount.replace("act_", "")})…` : "Refreshing data…"}
          </div>
          <div style={{ color: "rgba(223,230,255,0.6)", fontSize: 12 }}>
            {elapsed}s · live pull may take up to a minute on large accounts
          </div>
          <style>{`@keyframes xspin { to { transform: rotate(360deg); } }`}</style>
        </div>
      ) : null}

      {/* Slim inline strip (always, even for brief pulls): the outcome + pull button. */}
      <div
        style={{
          position: "sticky", top: 0, zIndex: 90, display: "flex", gap: 10,
          alignItems: "center", justifyContent: "space-between",
          padding: "7px 14px", margin: "0 0 8px",
          background: "rgba(13,18,32,0.96)", borderTop: "1px solid rgba(79,140,255,0.18)",
          fontSize: 12, color: "rgba(223,230,255,0.85)",
        }}
        role="status"
      >
        {phase === "pulling" ? (
          <span>
            <span aria-hidden>⟳</span> Pulling fresh data… ({elapsed}s)
          </span>
        ) : phase === "updated" ? (
          <span style={{ color: "#3ecf8e" }}>✓ Data up to date (just pulled)</span>
        ) : (
          <span style={{ opacity: 0.8 }}>{note || "auto-pulls on every refresh + every 60 s"}</span>
        )}
        <button
          className="btn sm"
          onClick={() => void doPull(true)}
          disabled={phase === "pulling"}
          style={{ opacity: phase === "pulling" ? 0.6 : 1 }}
          title="Force a real Meta pull right now (bypasses the 5-min auto throttle)"
        >
          Pull now
        </button>
      </div>
    </>
  );
}
