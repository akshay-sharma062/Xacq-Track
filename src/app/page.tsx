import { Topbar } from "./components/Topbar";
import { Stat, BarChart, Meter, Thumbnail, inr, pct, SectionTitle } from "./components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { visibleClients } from "@/lib/session";
import { dashboardAll, SpendRange } from "@/lib/dashboard";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { AutoRefresh } from "./components/AutoRefresh";
import { RangePicker } from "./components/RangePicker";

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
  // D-08: the date-range control (`?range=` + `?rFrom`/`?rTo` when custom).
  // Absent = the default 30d native view (byte-identical to pre-D-08 behaviour).
  const rangeParam = (sp.range as SpendRange | undefined) ?? undefined;
  const customRange =
    rangeParam === "custom" && (sp.rFrom || sp.rTo)
      ? { dayStart: sp.rFrom ?? undefined, dayEnd: sp.rTo ?? null }
      : undefined;
  const d = await dashboardAll(prisma, clientIds, "last_paid_click", 30, adAccountMeta, rangeParam, customRange);
  const k = d.kpi;
  const view = isAll ? "All clients" : clientIds.length ? "Client" : "";
  const acctLabel = adAccountMeta ? ` · ${adAccountMeta}` : "";
  const rangeLabel = d.spendRange ? d.spendRange.label : "last 30 days";

  return (
    <>
      <Topbar title="Dashboard" crumb={`${view} · ${rangeLabel}${acctLabel}`} />

      {/* §3b: "Data as of HH:MM IST · next update in N min" + 60s auto-poll. */}
      <AutoRefresh dataAsOf={d.sync.dataAsOf} />

      {/* D-08: the date-range control. 30d is the default (the stored rollup);
          beyond that, Meta returns no per-day data (probe), so the dashboard
          shows closest-available + the honest label below the KPIs. */}
      <RangePicker />
      {d.spendRange && !d.spendRange.native && (
        <div className="card" style={{ fontSize: 12, padding: "8px 12px" }} role="note">
          <span className="badge warn">data basis</span>{" "}
          <span className="muted">{d.spendRange.dataBasis} — the numbers below are the closest stored data, not a {d.spendRange.label.toLowerCase()} slice.</span>
        </div>
      )}

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

      {/* D-12: engagement KPI row — computed ONLY over the same stored Spend
          rows the spend KPIs above use (same range + client + ad-account
          filters; no new Meta calls, no new DB writes). Impressions/reach/
          clicks are currency-agnostic; CTR + CPC follow the spend KPIs'
          INR display. LPV/CLPV: probe-proven unavailable on Meta v23.0 for
          these accounts (D-08) — honest footnote, never a zero column. */}
      <div className="card mb">
        <SectionTitle right={<span className="faint" style={{ fontSize: 11 }}>{rangeLabel}</span>}>
          Ad engagement (stored {rangeLabel === "Last 30 days" ? "30-day rollup" : "Spend rows"})
        </SectionTitle>
        <div className="grid cols-5" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
          <Stat label="Total Impressions" value={k.engagement.impressions.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="Total Reach" value={k.engagement.reach.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="Total Clicks" value={k.engagement.clicks.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="CTR" value={pct(k.engagement.ctr)} sub="clicks / impressions" />
          <Stat label="CPC" value={k.engagement.clicks ? inr(k.engagement.cpc) : "—"} sub="spend INR / clicks" tone={k.engagement.clicks ? "accent" : undefined} />
        </div>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }} role="note">
          LPV/CLPV not available on this Meta API version (v23.0 returns 400 on the lpv/clpv fields — D-08 probe). Not shown; no cost/LPV is guessed.
        </div>
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
              {/* D-08: Meta ad-account balance (bill amount due, account currency) —
                  probe (a) 200. null = not yet pulled → "—" (never a fake 0). */}
              <span className="d faint" style={{ fontSize: 11 }} title="Meta ad-account balance (bill amount due), pulled from the Marketing API. '—' = not pulled yet.">
                balance (due) {a.balance != null ? <b className="mono">{a.currency} {Number(a.balance).toLocaleString("en-IN")}</b> : "— (not pulled yet)"}
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

      {/* D-10: on-demand LIVE Meta range strip — only shown when the active
          range is one Meta can actually serve on this account (yesterday / 7d,
          per the D-10 re-probe: 365/730d clamp to the stored 30d, so those
          keep the "30-day rollup only" label above instead). SERVER-ONLY
          fetch (the dashboard route calls it, never the browser); cached
          per account+day, so re-selecting the same range does NOT re-hit
          Meta. A 4xx shows the EXACT Meta string, never an empty grid. */}
      {d.liveRanges && d.liveRanges.length > 0 && (
        <div className="card" style={{ padding: "10px 12px" }}>
          <SectionTitle>
            {d.liveRanges[0].rangeKey === "yesterday" ? "Live yesterday (Meta)" : "Live 7 days (Meta)"}
          </SectionTitle>
          <div className="row spread" style={{ gap: 12, fontSize: 13, flexWrap: "wrap" }}>
            {d.liveRanges.map((lr) => {
              if (lr.blockedNote) {
                return (
                  <span key={lr.adAccountId} className="badge bad" title={lr.blockedNote}>
                    {lr.accountName}: BLOCKED — {lr.blockedNote.slice(0, 90)}
                  </span>
                );
              }
              const when = lr.fetchedAt ? lr.fetchedAt.slice(11, 16) : "—";
              return (
                <span key={lr.adAccountId} title={`Meta window ${lr.dateStart}..${lr.dateStop}${lr.clamped ? " (Meta served a narrower window than requested)" : ""}`}>
                  <b>{lr.accountName}</b>{" "}
                  <span className="mono good">{inr(lr.spendInr)}</span>{" "}
                  <span className="faint">
                    ({lr.currency} {Math.round(lr.spendNative).toLocaleString("en-IN")}) ·{" "}
                    {lr.fresh ? `live, ${when} IST` : `cached ${when} IST`}
                    {lr.clamped ? " · Meta served a narrower window than requested" : ""}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            On-demand Meta fetch (server-side only, cached per account+day) — the stored 30-day rollup below is unchanged.
            {d.liveRanges.some((lr) => lr.clamped) && " A clamped window means Meta only has ≤30 days of spend data on this account, so it returned its stored window, not the full requested range."}
          </div>
        </div>
      )}

      {/* D-10: per-ad-set metrics table — STORED Spend/AdSet rows only (never
          a live call, never an estimate). ROAS is shown only where sales
          exist (0 pre G3/G4). LPV/CLPV are NOT columns: Meta v23.0 400s them
          on these accounts (D-08/D-10 probes) → the honest note below,
          never a zero-column or a guessed cost/LPV. */}
      <div className="card">
        <SectionTitle right={<Link className="faint" href="/reports?key=ad_set">Ad-set table →</Link>}>
          Ad sets by spend (30d, stored)
        </SectionTitle>
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad set</th>
              <th>Campaign</th>
              <th style={{ textAlign: "right" }}>Spend (native)</th>
              <th style={{ textAlign: "right" }}>Spend (INR)</th>
              <th style={{ textAlign: "right" }}>Impressions</th>
              <th style={{ textAlign: "right" }}>Reach</th>
              <th style={{ textAlign: "right" }}>Clicks</th>
              <th style={{ textAlign: "right" }}>CPM</th>
              <th style={{ textAlign: "right" }}>CPC</th>
              <th style={{ textAlign: "right" }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {d.adSets.map((r) => (
              <tr key={r.adsetId}>
                <td className="mono" style={{ fontSize: 12 }}>{r.adsetName}</td>
                <td className="faint" style={{ fontSize: 12 }}>{r.campaignName}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.currency} {r.spendNative.toLocaleString("en-IN")}</td>
                <td style={{ textAlign: "right" }} className="mono">{inr(r.spendInr)}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.impressions.toLocaleString("en-IN")}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.reach.toLocaleString("en-IN")}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.clicks.toLocaleString("en-IN")}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.cpm ? inr(r.cpm) : "—"}</td>
                <td style={{ textAlign: "right" }} className="mono">{r.cpc ? inr(r.cpc) : "—"}</td>
                <td style={{ textAlign: "right" }} className={r.roas > 0 ? "good mono" : "faint mono"}>
                  {r.roas > 0 ? r.roas.toFixed(2) + "×" : "— (no sales yet)"}
                </td>
              </tr>
            ))}
            {d.adSets.length === 0 && (
              <tr>
                <td colSpan={10} className="empty">
                  No stored ad-set spend rows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 11, marginTop: 8 }} title="D-08/D-10 probe: Meta Marketing API v23.0 returns 400 for lpv/clpv fields on these accounts — the note is the committed honest record, not a hidden zero-column.">
          LPV/CLPV: not returned by Meta v23.0 on these accounts (400 on the fields — D-08/D-10 probes). No cost/LPV is guessed.
        </div>
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
