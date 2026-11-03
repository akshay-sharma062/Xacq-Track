"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dashboard-V2 §3b: the dashboard auto-refreshes itself without a manual reload.
 * The client polls `/api/session` (cheap, local) every 60 s and triggers a
 * server-component re-render (router.refresh) so the DB-backed numbers update.
 * No Meta calls from the browser — Meta pulls happen server-side via the
 * 10-min scheduler tick or the "Pull from Meta" button only.
 *
 * Also shows the "Data as of HH:MM IST · next update in N min" stamp.
 */
export function AutoRefresh({ dataAsOf }: { dataAsOf: string | null }) {
  const router = useRouter();
  const [now, setNow] = useState<number>(Date.now());

  // 60 s auto-poll: re-render the server component to pull fresh DB numbers.
  useEffect(() => {
    const id = setInterval(() => {
      void fetch("/api/session").then(() => router.refresh()).catch(() => {});
    }, 60_000);
    return () => clearInterval(id);
  }, [router]);

  // 1 s tick for the live countdown (cheap local clock, no network).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const ist = (iso: string | null) =>
    iso ? new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "never";

  // Next 10-min tick boundary (the scheduler fires on the :00/:10/… grid).
  const nextInMs = 600_000 - (now % 600_000);
  const nextInMin = Math.max(0, Math.ceil(nextInMs / 60_000));

  return (
    <div className="card" style={{ fontSize: 12, marginBottom: 12, opacity: 0.92 }}>
      <div className="row spread">
        <span className="muted">
          Data as of <b>{ist(dataAsOf)} IST</b>
        </span>
        <span className="muted">
          next update in <b>{nextInMin} min</b> · auto-refresh every 60 s
        </span>
      </div>
    </div>
  );
}
