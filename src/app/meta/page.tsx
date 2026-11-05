import { Topbar } from "../components/Topbar";
import { inr } from "../components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { capiStatus } from "@/lib/meta/capi";
import { PullButton } from "./PullButton";

/**
 * Screens 7–8 — Meta ads-pull status (spec 5.7) + Meta CAPI send status
 * (spec 5.8). Ad accounts show last-pulled + 30-day spend; the CAPI panel
 * shows the per-event send status, Event Match Quality, and a button to run
 * the send/retry queue (with dedup + "never send a refunded Purchase" guards).
 */
export const dynamic = "force-dynamic";

export default async function MetaPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Meta pull + CAPI" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Meta pull + CAPI" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const accounts = await prisma.adAccount.findMany({
    where: { clientId },
    include: { spend: { where: { day: { gte: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) } }, select: { inrSpend: true } } },
  });
  const status = await capiStatus(prisma, clientId);

  const hasToken = Boolean(process.env.META_ACCESS_TOKEN);

  return (
    <>
      <Topbar title="Meta pull + CAPI" crumb={client?.name} />

      <div className="card mb">
        <div className="row spread">
          <div>
            <h3 style={{ margin: 0 }}>Meta Marketing API pull (spec 5.7)</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              {hasToken
                ? "Live: with META_ACCESS_TOKEN set, pulls campaigns/ad sets/ads + daily insights."
                : "Simulated: no META_ACCESS_TOKEN set — pulls a deterministic fixture so reports work offline."}
            </div>
          </div>
          <PullButton clientId={clientId} simulate={!hasToken} />
        </div>

        <div className="grid cols-3 mt">
          {accounts.map((a) => {
            const spend30 = a.spend.reduce((sum, r) => sum + (r.inrSpend ?? 0), 0);
            return (
              <div key={a.id} className="card" style={{ background: "var(--panel-2)" }}>
                <div className="row spread">
                  <strong>{a.name}</strong>
                  <span className="badge">{a.currency}</span>
                </div>
                <div className="faint mono" style={{ fontSize: 11 }}>
                  {a.metaId}
                </div>
                <div className="row spread mt">
                  <span className="muted" style={{ fontSize: 12 }}>
                    30d spend
                  </span>
                  <span className="mono good">{inr(spend30)}</span>
                </div>
                {/* D-08: the ad-account balance (bill amount due, billing
                    currency) from the probe-proven `fields=balance` pull.
                    null = not yet pulled → "—" (never a fake 0). Meta "Leads"
                    is intentionally NOT shown here: it is not an insights
                    metric on these accounts (probe: 400) — its source is G2
                    Instant Forms (deferred) or G3 clicks (DECISIONS D-08). */}
                <div className="row spread" style={{ marginTop: 6 }}>
                  <span className="muted" style={{ fontSize: 12 }} title="Meta ad-account balance (bill amount due).">
                    balance (due)
                  </span>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {a.balance != null ? `${a.currency} ${Number(a.balance).toLocaleString("en-IN")}` : "— (not pulled)"}
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 11 }}>
                  last pulled {a.lastPulledAt ? new Date(a.lastPulledAt).toLocaleString() : "never"}
                </div>
              </div>
            );
          })}
          {accounts.length === 0 ? <div className="empty">No ad accounts yet — run a pull.</div> : null}
        </div>
      </div>

      <div className="card">
        <div className="row spread mb">
          <h3 style={{ margin: 0 }}>CAPI send status (spec 5.8)</h3>
          <div className="row">
            <span className="badge good">{status.counts.sent} sent</span>
            <span className="badge warn">{status.counts.queued} queued</span>
            <span className="badge bad">{status.counts.failed} failed</span>
            <span className="badge">{status.counts.skipped} skipped</span>
          </div>
        </div>
        {/* G8: live vs simulated split — a simulated send (no token/pixel) is
            never presented as a live Meta send. */}
        <div className="row mb" style={{ gap: 16, fontSize: 13 }}>
          <span>
            live to Meta <b className="good">{status.liveSent}</b>
          </span>
          <span>
            simulated (local) <b>{status.simulatedSent}</b>
          </span>
          <span className="muted">
            avg Purchase MQ (Meta-reported):{" "}
            <strong className={status.avgPurchaseMq != null && status.avgPurchaseMq >= 7 ? "good" : "warn"}>
              {status.avgPurchaseMq ?? "n/a — no live Purchase EMQ yet"}
            </strong>
            {status.avgPurchaseMqEstimated != null && (
              <span className="faint"> · est {status.avgPurchaseMqEstimated} (local heuristic, not Meta's number)</span>
            )}
          </span>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Event</th>
              <th>Value</th>
              <th>Match Q</th>
              <th>Status</th>
              <th style={{ textAlign: "right" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {status.rows.slice(0, 20).map((r) => (
              <tr key={r.id}>
                <td>
                  <span className="badge accent">{r.type}</span>
                  {r.error ? <div className="faint" style={{ fontSize: 11 }}>{r.error}</div> : null}
                </td>
                <td className="mono">{r.value ? inr(r.value) : "—"}</td>
                <td className="mono">
                  {r.matchQuality != null ? (
                    <>
                      {r.matchQuality}
                      {r.emqFromMeta ? <span className="faint"> (Meta)</span> : <span className="faint"> (est)</span>}
                    </>
                  ) : r.simulated ? (
                    <span className="faint">simulated</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <span className={`badge ${r.status === "sent" ? (r.simulated ? "" : "good") : r.status === "failed" ? "bad" : r.status === "skipped" ? "warn" : ""}`}>
                    {r.status === "sent" && r.simulated ? "sent (sim)" : r.status}
                  </span>
                </td>
                <td style={{ textAlign: "right" }} className="faint">
                  {new Date(r.eventTime).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Rules enforced: never send an event twice (dedup key) · never send a Purchase for a
          refunded payment (recorded as a skipped Refund note).
          {status.rows.length === 0 && " No CAPI events yet for this client."}
        </div>
      </div>
    </>
  );
}
