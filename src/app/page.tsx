import { Topbar } from "./components/Topbar";
import { Stat, BarChart, Meter, Thumbnail, inr, pct, SectionTitle } from "./components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { visibleClients } from "@/lib/session";
import { dashboardAll } from "@/lib/dashboard";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { AutoRefresh } from "./components/AutoRefresh";

/**
 * Screen 1 — Dashboard. Dashboard-V2 §1/§2: the DEFAULT view is the ALL-clients
 * / ALL-accounts aggregate (dense, every Meta-relevant figure from the G1
 * pulls); picking a specific client or `?adAccount=` in the Topbar drills into
 * the same dense layout scoped to that set. §3b: the numbers auto-refresh
 * every 60 s (cheap local report reads — no Meta calls from the browser).
 * A 0 in the leads-family is the honest empty state pre G3/G4, labelled as such.
 */
export const dynamic = "force-dynamic";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Dashboard" crumb="Not signed in" />
        <div className="card empty">No demo user configured. Set DEMO_USER in .env.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const client = sp.client;
  const isAll = !client || client === "all";
  // All view = the whole visible client set; drill-down = that one client.
  const visible = await visibleClients(s);
  const drill = isAll ? null : await resolveClient(s, client);
  const clientIds = isAll ? visible : drill ? [drill] : [];
  if (clientIds.length === 0) {
    return (
      <>
        <Topbar title="Dashboard" crumb={s.name} />
        <div className="card empty">No visible client for this user.</div>
      </>
    );
  }

  const adAccountMeta = sp.adAccount ?? undefined;
  const d = await dashboardAll(prisma, clientIds, "last_paid_click", 30, adAccountMeta);
  const k = d.kpi;
  const view = isAll ? "All clients" : clientIds.length ? "Client" : "";
  const acctLabel = adAccountMeta ? ` · ${adAccountMeta}` : "";

  return (
    <>
      <Topbar title="Dashboard" crumb={`${view} · last 30 days${acctLabel}`} />

      {/* §3b: "Data as of HH:MM IST · next update in N min" + 60s auto-poll. */}
      <AutoRefresh dataAsOf={d.sync.dataAsOf} />

      {/* §2 A: aggregate KPI row (all-currency + INR-normalized; FX-missing shown). */}
      <div className="grid cols-4 mb">
        <Stat
          label="Ad spend 30d"
          value={inr(k.spendInr)}
          sub={
            <span>
              {k.spendByCurrency.map((c) => `${c.currency} ${Math.round(c.native).toLocaleString("en-IN")}`).join(" · ") || "—"}
            </span>
          }
          tone="accent"
        />
        <Stat label="Revenue (net)" value={inr(k.revenueInr)} sub={`${k.sales} sales · ROAS ${Number.isFinite(k.roas) ? k.roas.toFixed(1) + "×" : "—"}`} tone="good" />
        <Stat
          label="Leads"
          value={k.leads}
          sub={k.leads === 0 ? "AWAITING LIVE TRAFFIC (G3/G4)" : `${k.registered} reg · ${k.attended} attended · ${k.callsBooked} calls`}
        />
        <Stat label="Cost / sale" value={inr(k.costPerSale)} sub={k.sales === 0 ? "no sales yet" : `ROI ${pct(k.roas)}`} tone={k.roas >= 0 ? "good" : "warn"} />
      </div>

      {/* §2 B: per-ad-account cards — 7 by default, each a clickable drill-down. */}
      <div className="card">
        <SectionTitle right={<Link className="faint" href="/meta">Meta pull + CAPI →</Link>}>
          Ad accounts ({d.accounts.length})
        </SectionTitle>
        <div className="grid cols-4 mb">
          {d.accounts.map((a) => (
            <div key={a.metaId} className="card stat">
              <span className="k">
                <Link href={`?adAccount=${a.metaId}`} style={{ textDecoration: "none" }} title={`Filter to ${a.name}`}>
                  {a.name}
                </Link>
              </span>
              <span className="v accent">{inr(a.spendInr)}</span>
              <span className="d muted">
                {a.metaId} · {a.currency} ·{" "}
                <span className={`badge ${a.status === "ACTIVE" ? "good" : "warn"}`}>{a.status}</span>
              </span>
              <span className="d mono">
                {a.campaigns} camp · {a.ads} ads
              </span>
              <span className="d faint" style={{ fontSize: 11 }}>
                pulled {a.lastPulledAt ? a.lastPulledAt.slice(5, 16).replace("T", " ") + " IST" : "never"}
              </span>
            </div>
          ))}
          {d.accounts.length === 0 && <div className="empty">No ad accounts in this view — run a Meta pull.</div>}
        </div>
      </div>

      {/* §2: charts */}
      <div className="grid cols-2 mb">
        <div className="card">
          <SectionTitle>Daily ad spend (INR)</SectionTitle>
          <BarChart data={d.spendByDay} color="var(--accent)" unit=" " />
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            G1 note: per-day only where Meta exposes it; else the 30-day rollup (one point = the window's date_stop).
          </div>
        </div>
        <div className="card">
          <SectionTitle>Top campaigns by spend 30d</SectionTitle>
          <div className="stack">
            {d.topCampaigns.slice(0, 5).map((c) => (
              <Meter key={c.campaign} label={`${c.campaign} (${c.account})`} value={c.spendInr} max={Math.max(...d.topCampaigns.map((x) => x.spendInr), 1)} tone="accent" />
            ))}
            {d.topCampaigns.length === 0 && <div className="empty">No spend yet.</div>}
          </div>
        </div>
      </div>

      {/* §2: top ads table (thumbnail + spend; sales/ROAS honest 0 pre G3/G4). */}
      <div className="card">
        <SectionTitle right={<Link className="faint" href="/reports?key=ad_perf">Ad table →</Link>}>
          Top ads by spend (30d)
        </SectionTitle>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 64 }}>Ad</th>
              <th>Name</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Sales</th>
              <th style={{ textAlign: "right" }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {d.topAds.map((r) => (
              <tr key={r.adId}>
                <td>
                  <Thumbnail url={r.thumbnail} name={r.adName} />
                </td>
                <td>{r.adName}</td>
                <td style={{ textAlign: "right" }} className="mono">
                  {inr(r.spendInr)}
                </td>
                <td style={{ textAlign: "right" }} className="faint">
                  {r.sales === 0 ? "0 (no live traffic yet)" : r.sales}
                </td>
                <td style={{ textAlign: "right" }} className={r.roas >= 1 ? "good" : "faint"}>
                  {r.roas > 0 ? r.roas.toFixed(1) + "×" : "—"}
                </td>
              </tr>
            ))}
            {d.topAds.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No spend rows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* §2 E: CAPI pipeline strip (honest zeros until G8 live). */}
      <div className="card">
        <SectionTitle right={<Link className="faint" href="/meta">Details →</Link>}>
          CAPI send status
        </SectionTitle>
        <div className="row spread" style={{ gap: 16, fontSize: 13 }}>
          <span>
            queued <b>{d.capi.queued}</b>
          </span>
          <span title="G8: 'live' = a real Meta Conversions API POST; 'simulated' = local mark, no token/pixel yet">
            sent <b className="good">{d.capi.sent}</b>{" "}
            <span className="faint">({d.capi.live} live · {d.capi.simulated} sim)</span>
          </span>
          <span>
            failed <b className="bad">{d.capi.failed}</b>
          </span>
          <span>
            skipped <b>{d.capi.skipped}</b>
          </span>
          <span title="G8: Meta's OWN Event Match Quality on Purchase (acceptance EMQ ≥ 7). '—' = no live Purchase EMQ yet.">
            avg match-Q (Meta) <b>{d.capi.avgMqMeta ?? "—"}</b>
            {d.capi.avgMqEst != null && <span className="faint"> · est {d.capi.avgMqEst}</span>}
          </span>
          {d.capi.total === 0 && <span className="faint">0 events queued — no CAPI traffic yet (G8)</span>}
        </div>
      </div>

      {/* §2 F: sync / FX strip — data-as-of + rate table with backfill-pending. */}
      <div className="card">
        <SectionTitle>Sync + FX</SectionTitle>
        <div className="row spread" style={{ fontSize: 13, gap: 16 }}>
          <span className="muted">
            Data as of <b>{d.sync.dataAsOf ? d.sync.dataAsOf.slice(5, 16).replace("T", " ") + " IST" : "no pull yet"}</b> · next update ≤10 min (10-min tick)
          </span>
          <span>
            {d.sync.fx
              .map((r) => `${r.currency}→INR ${r.rate}${r.backfillPending ? " (backfill pending)" : ""}`)
              .join(" · ") || "no stored FX rates"}
          </span>
        </div>
      </div>

      <div className="row mt">
        <Link className="btn" href="/leads">
          Open lead list
        </Link>
        <Link className="btn" href="/pipeline">
          Pipeline
        </Link>
        <Link className="btn" href="/meta">
          Meta pull + CAPI
        </Link>
      </div>
    </>
  );
}
