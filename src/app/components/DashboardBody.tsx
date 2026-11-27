"use client";

import { useMemo, useState } from "react";
import {
  Stat,
  BarChart,
  Meter,
  Thumbnail,
  inr,
  pct,
  SectionTitle,
  ist,
} from "./ui";
import {
  DonutChart,
  LineChart,
  BarChartV2,
  GaugeChart,
} from "./Charts";
import { CountUp } from "./CountUp";
import { useAnimate } from "./useAnimate";
import Link from "next/link";

/* ─── types (match server-side data shapes from dashboardAll) ─── */
type Kpi = {
  spendInr: number;
  spendByCurrency: { currency: string; native: number }[];
  revenueInr: number;
  sales: number;
  roas: number;
  leads: number;
  registered: number;
  attended: number;
  callsBooked: number;
  costPerSale: number;
  engagement: { impressions: number; reach: number; clicks: number; ctr: number; cpc: number };
};
type SpendRangeInfo = {
  label: string;
  native: boolean;
  dataBasis: string | null;
};
type AccountSummary = {
  metaId: string;
  name: string;
  currency: string;
  status: string;
  spendInr: number;
  campaigns: number;
  ads: number;
  leads: number;
  lastPulledAt: string | null;
  balance: number | null;
  balanceAsOf: string | null;
  clientId?: string;
};
type AdSetRow = {
  adsetId: string;
  adsetName: string;
  campaignName: string;
  currency: string;
  spendNative: number;
  spendInr: number;
  impressions: number;
  reach: number;
  clicks: number;
  cpm: number | null;
  cpc: number | null;
  roas: number;
};
type AdPerfRow = {
  adId: string;
  adName: string;
  thumbnail: string | null;
  spendInr: number;
  sales: number;
  roas: number;
};
type SpendDay = { date: string; value: number };
type LiveRange = {
  rangeKey: string;
  accountName: string;
  adAccountId: string;
  spendInr: number;
  spendNative: number;
  currency: string;
  fetchedAt: string | null;
  fresh: boolean;
  clamped: boolean;
  dateStart: string | null;
  dateStop: string | null;
  blockedNote: string | null;
};
type ClientProfile = {
  name: string;
  updatedAt: Date;
  offerPrice: number;
  attributionModel: string;
  attributionWindowDays: number;
  timezone: string;
  currency: string;
  capiEventType: string | null;
  metaPageId: string | null;
  metaPixelId: string | null;
  funnelCount: number;
  leadCount: number;
  workspaceName: string;
};
type DashboardProps = {
  profile: ClientProfile | null;
  allClientNames: string[] | null;
  isAll: boolean;
  rangeLabel: string;
  spendRange: SpendRangeInfo | null;
  kpi: Kpi;
  accounts: AccountSummary[];
  spendByDay: { date: string; value: number }[];
  sourceMix: { label: string; count: number }[];
  topCampaigns: { label: string; value: number }[];
  topAds: AdPerfRow[];
  adSets: AdSetRow[];
  liveRanges: LiveRange[];
};

/* ─── gradient accent line colors per metric type ─── */
const ACCENT_GRADIENTS: Record<string, string> = {
  spend: "linear-gradient(90deg, #4f8cff, transparent)",
  leads: "linear-gradient(90deg, #7c5cff, transparent)",
  revenue: "linear-gradient(90deg, #3ecf8e, transparent)",
  cps: "linear-gradient(90deg, #f5b83d, transparent)",
  registered: "linear-gradient(90deg, #7fd4ff, transparent)",
  calls: "linear-gradient(90deg, #c3b3ff, transparent)",
  roas: "linear-gradient(90deg, #ffd089, transparent)",
  ctr: "linear-gradient(90deg, #8ff0d4, transparent)",
};

export default function DashboardBody({
  profile,
  allClientNames,
  isAll,
  rangeLabel,
  spendRange,
  kpi,
  accounts,
  spendByDay,
  sourceMix,
  topCampaigns,
  topAds,
  adSets,
  liveRanges,
}: DashboardProps) {
  const animRef = useAnimate(80);

  /* ═══ KPI data derived from server-side kpi (memoized for chart re-renders) ═══ */
  const sourceData = useMemo(() => {
    const colors = ["#4f8cff", "#7c5cff", "#3ecf8e", "#f5b83d", "#ff6b6b", "#c3b3ff", "#ffd089", "#8ff0d4"];
    return (sourceMix || []).map((m, i) => ({
      label: m.label || "?",
      value: m.count,
      color: colors[i % colors.length],
    }));
  }, [sourceMix]);

  const campaignData = useMemo(
    () => (topCampaigns || []).slice(0, 10).map((c) => ({ label: c.label, value: c.value })),
    [topCampaigns]
  );

  return (
    // ONE observer root wrapping every `.animate-in` block. (The blank-body
    // bug: the same ref was previously attached to 3 sibling divs — React
    // keeps only the last = the charts-row-2 div, whose children are NOT
    // `.animate-in` — so `useAnimate` found 0 targets, never ran its
    // observer, and the whole body stayed stuck at `opacity:0`.)
    <div ref={animRef}>
      {/* ─── Client-profile band ─── */}
      {profile ? (
        <div className="card mb animate-in">
          <SectionTitle right={<span className="faint" style={{ fontSize: 11 }} title="Client row last-changed (updatedAt)">last changed {ist(profile.updatedAt.toISOString())} IST</span>}>
            Client profile · <span className="accent">{profile.name}</span>
          </SectionTitle>
          <div className="grid cols-4" style={{ fontSize: 13 }}>
            <span title="Offer price (INR) used for profit math"><b className="mono">{inr(profile.offerPrice)}</b> offer</span>
            <span title="Attribution default"><b>{profile.attributionModel.replace(/_/g, " ")}</b> · {profile.attributionWindowDays}d</span>
            <span title="Client timezone"><b>{profile.timezone}</b> · {profile.currency}</span>
            <span title="CAPI event type"><b className="mono">{profile.capiEventType ?? "—"}</b></span>
            <span title="Meta Page id (config)">page <b className="mono">{profile.metaPageId ?? "—"}</b></span>
            <span title="Meta CAPI pixel / data-source id">pixel <b className="mono">{profile.metaPixelId ?? "—"}</b></span>
            <span>funnels <b>{profile.funnelCount}</b> · leads <b>{profile.leadCount}</b></span>
            <span className="faint">ws <b>{profile.workspaceName}</b></span>
          </div>
        </div>
      ) : isAll ? (
        <div className="card mb animate-in" style={{ fontSize: 12, padding: "10px 12px" }}>
          <span className="badge accent">{allClientNames?.length ?? 0}</span>{" "}
          <span className="muted">
            clients in this view: {allClientNames?.join(" · ") ?? "—"} — pick one in the top bar for its profile
          </span>
        </div>
      ) : null}

      {/* ═══════════════════════════════════════════════════════
          D-20: Premium 8-card KPI grid
          ═══════════════════════════════════════════════════════ */}
      <div className="grid cols-2 mb" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
        <KpiCard
          gradient={ACCENT_GRADIENTS.spend}
          icon="💰"
          label="Ad Spend 30d"
          value={<><CountUp end={kpi.spendInr} prefix="₹" /><br /><span className="faint" style={{ fontSize: 10 }}>{kpi.spendByCurrency.map((c) => `${c.currency} ${Math.round(c.native).toLocaleString("en-IN")}`).join(" · ") || "—"}</span></>}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.leads}
          icon="📥"
          label="Leads"
          value={<><CountUp end={kpi.leads} /><br /><span className="faint" style={{ fontSize: 10 }}>{kpi.leads === 0 ? "AWAITING LIVE TRAFFIC (G3/G4)" : `${kpi.registered} reg · ${kpi.attended} attended · ${kpi.callsBooked} calls`}</span></>}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.revenue}
          icon="💵"
          label="Revenue (net)"
          value={<><CountUp end={kpi.revenueInr} prefix="₹" /><br /><span className="faint" style={{ fontSize: 10 }}>{kpi.sales} sales · ROAS {Number.isFinite(kpi.roas) ? kpi.roas.toFixed(1) + "×" : "—"}</span></>}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.cps}
          icon="📊"
          label="Cost / sale"
          value={<><CountUp end={kpi.costPerSale} prefix="₹" /><br /><span className="faint" style={{ fontSize: 10 }}>{kpi.sales === 0 ? "no sales yet" : `ROI ${pct(kpi.roas)}`}</span></>}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.registered}
          icon="👤"
          label="Registered"
          value={<CountUp end={kpi.registered} />}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.calls}
          icon="📞"
          label="Calls booked"
          value={<CountUp end={kpi.callsBooked} />}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.roas}
          icon="🎯"
          label="ROAS"
          value={<>{Number.isFinite(kpi.roas) ? kpi.roas.toFixed(1) + "×" : "—"}</>}
        />
        <KpiCard
          gradient={ACCENT_GRADIENTS.ctr}
          icon="📈"
          label="CTR"
          value={<>{pct(kpi.engagement.ctr)}</>}
        />
      </div>

      {/* ─── Engagement row (server-rendered Stat cards — unchanged) ─── */}
      <div className="card mb animate-in">
        <SectionTitle right={<span className="faint" style={{ fontSize: 11 }}>{rangeLabel}</span>}>
          Ad engagement
        </SectionTitle>
        <div className="grid cols-2 mb" style={{ gridTemplateColumns: "repeat(5, 1fr)" }}>
          <Stat label="Total Impressions" value={kpi.engagement.impressions.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="Total Reach" value={kpi.engagement.reach.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="Total Clicks" value={kpi.engagement.clicks.toLocaleString("en-IN")} sub="stored Spend rows" />
          <Stat label="CTR" value={pct(kpi.engagement.ctr)} sub="clicks / impressions" />
          <Stat label="CPC" value={kpi.engagement.clicks ? inr(kpi.engagement.cpc) : "—"} sub="spend INR / clicks" tone="accent" />
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          LPV/CLPV not available on this Meta API version (v23.0 returns 400 on the lpv/clpv fields — D-08 probe). Not shown; no cost/LPV is guessed.
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          Charts Row 1 — Daily spend (LineChart) + Source mix (DonutChart)
          ═══════════════════════════════════════════════════════ */}
      <div className="grid cols-2 mb">
        <ChartCard title="Daily ad spend (INR)" right={<span className="faint" style={{ fontSize: 11 }}>{rangeLabel}</span>}>
          <LineChart data={spendByDay} color="#4f8cff" unit="₹" label="Spend" />
          <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
            G1 note: per-day only where Meta exposes it; else the 30-day rollup.
          </div>
        </ChartCard>
        <ChartCard title="Source mix">
          {sourceData.length > 0 ? (
            <>
              <DonutChart data={sourceData} size={220} centerLabel="sources" />
              <div className="row" style={{ gap: 12, justifyContent: "center", marginTop: 8, flexWrap: "wrap" }}>
                {sourceData.map((s, i) => (
                  <span key={i} className="faint" style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color, display: "inline-block" }} />
                    {s.label} ({s.value})
                  </span>
                ))}
              </div>
            </>
          ) : (
            <div className="empty" style={{ padding: 40 }}>
              No lead source data yet — the source-mix donut appears once leads are captured (G3/G4 live traffic).
            </div>
          )}
        </ChartCard>
      </div>

      {/* ═══════════════════════════════════════════════════════
          Charts Row 2 — Top campaigns (BarChartV2 horizontal) + ROAS gauge
          ═══════════════════════════════════════════════════════ */}
      <div className="grid cols-2 mb">
        <ChartCard title="Top campaigns by spend 30d">
          {campaignData.length > 0 ? (
            <BarChartV2 data={campaignData} horizontal color="#4f8cff" unit="₹" />
          ) : (
            <div className="empty" style={{ padding: 40 }}>No spend yet.</div>
          )}
        </ChartCard>
        <ChartCard title="Key metrics">
          <div className="grid cols-2" style={{ gap: 12 }}>
            <div>
              <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>ROAS</div>
              <GaugeChart value={kpi.roas} max={5} label="×" thresholds={{ warn: 1, good: 3 }} />
            </div>
            <div>
              <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>Cost / sale</div>
              <GaugeChart value={kpi.costPerSale} max={kpi.costPerSale * 2 || 200000} label="₹" thresholds={{ warn: kpi.costPerSale * 1.5, good: kpi.costPerSale * 0.5 }} />
            </div>
          </div>
        </ChartCard>
      </div>

      {/* ─── Account cards ─── */}
      <AccountCards accounts={accounts} allClientNames={allClientNames} />

      {/* ─── D-10: live Meta range strip ─── */}
      {liveRanges && liveRanges.length > 0 && (
        <div className="card animate-in" style={{ padding: "10px 12px", marginTop: 14 }}>
          <SectionTitle>
            {liveRanges[0].rangeKey === "yesterday" ? "Live yesterday (Meta)" : "Live 7 days (Meta)"}
          </SectionTitle>
          <div className="row" style={{ gap: 12, fontSize: 13, flexWrap: "wrap" }}>
            {liveRanges.map((lr) => {
              if (lr.blockedNote) {
                return (
                  <span key={lr.adAccountId} className="badge bad" title={lr.blockedNote}>
                    {lr.accountName}: BLOCKED — {lr.blockedNote.slice(0, 90)}
                  </span>
                );
              }
              const when = lr.fetchedAt ? lr.fetchedAt.slice(11, 16) : "—";
              return (
                <span key={lr.adAccountId} title={`Meta window ${lr.dateStart}..${lr.dateStop}${lr.clamped ? " (clamped)" : ""}`}>
                  <b>{lr.accountName}</b>{" "}
                  <span className="mono good">{inr(lr.spendInr)}</span>{" "}
                  <span className="faint">
                    ({lr.currency} {Math.round(lr.spendNative).toLocaleString("en-IN")}) · {lr.fresh ? `live, ${when} IST` : `cached ${when} IST`}
                    {lr.clamped ? " · Meta served narrower window" : ""}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── Ad-set metrics + top ads tables (unchanged) ─── */}
      <div className="card animate-in tbl-wrap" style={{ marginTop: 14 }}>
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
            {adSets.map((r) => (
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
                <td style={{ textAlign: "right" }} className={r.roas >= 1 ? "good" : "faint"}>{r.roas > 0 ? r.roas.toFixed(1) + "×" : "—"}</td>
              </tr>
            ))}
            {adSets.length === 0 && (
              <tr><td colSpan={10} className="empty">No spend rows yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Top ads table */}
      <div className="card animate-in tbl-wrap" style={{ marginTop: 14 }}>
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
            {topAds.map((r) => (
              <tr key={r.adId}>
                <td><Thumbnail url={r.thumbnail} name={r.adName} /></td>
                <td>{r.adName}</td>
                <td style={{ textAlign: "right" }} className="mono">{inr(r.spendInr)}</td>
                <td style={{ textAlign: "right" }} className="faint">{r.sales === 0 ? "0 (no live traffic yet)" : r.sales}</td>
                <td style={{ textAlign: "right" }} className={r.roas >= 1 ? "good" : "faint"}>{r.roas > 0 ? r.roas.toFixed(1) + "×" : "—"}</td>
              </tr>
            ))}
            {topAds.length === 0 && (
              <tr><td colSpan={5} className="empty">No spend rows yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   Sub-components
   ═══════════════════════════════════════════════════════════════ */

function KpiCard({
  icon,
  label,
  value,
  gradient,
}: {
  icon: string;
  label: string;
  value: React.ReactNode;
  gradient: string;
}) {
  return (
    <div className="card stat animate-in" style={{ position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: gradient, borderRadius: "2px 2px 0 0" }} />
      {/* The FlexiFunnels card anatomy — the icon in a rounded tinted
          chip beside the label, the big value below. The .card:hover CSS
          already supplies the lift + shadow on hover. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          aria-hidden
          style={{
            width: 38, height: 38, borderRadius: 9, flex: "0 0 38px",
            display: "grid", placeItems: "center", fontSize: 18,
            background: "rgba(79,140,255,0.10)",
            border: "1px solid rgba(79,140,255,0.25)",
          }}
        >
          {icon}
        </span>
        <span className="k" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {label}
        </span>
      </div>
      <span className="v" style={{ fontSize: 30, marginTop: 10, letterSpacing: "-0.03em" }}>{value}</span>
    </div>
  );
}

function ChartCard({
  title,
  right,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <SectionTitle right={right}>{title}</SectionTitle>
      {children}
    </div>
  );
}

function AccountCards({ accounts, allClientNames }: { accounts: AccountSummary[]; allClientNames: string[] | null }) {
  const wrap = useAnimate();
  return (
    <div ref={wrap} className="card animate-in" style={{ marginTop: 14 }}>
      <SectionTitle right={<Link className="faint" href="/meta">Meta pull + CAPI →</Link>}>
        Ad accounts ({accounts.length})
      </SectionTitle>
      <div className="grid cols-2 mb" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
        {accounts.map((a) => (
          <AccountCard key={a.metaId} account={a} showSingleClientBadge={!!(allClientNames && allClientNames.length > 1)} />
        ))}
        {accounts.length === 0 && <div className="empty">No ad accounts in this view — run a Meta pull.</div>}
      </div>
    </div>
  );
}

/** One ad-account card with its hover treatment. Separate component so
 *  useState lives at a fixed position in the component tree (rules of
 *  hooks — never call useState inside a .map()). */
function AccountCard({
  account: a,
  showSingleClientBadge,
}: {
  account: AccountSummary;
  showSingleClientBadge: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="card stat"
      style={{
        position: "relative",
        overflow: "hidden",
        border: hover ? "1px solid rgba(79,140,255,0.2)" : "1px solid rgba(255,255,255,0.06)",
        transform: hover ? "translateY(-3px)" : undefined,
        boxShadow: hover ? "0 8px 32px rgba(0,0,0,0.3)" : undefined,
        transition: "transform 0.25s cubic-bezier(.4,0,.2,1), box-shadow 0.25s, border-color 0.25s",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "linear-gradient(90deg, var(--accent), transparent)", borderRadius: "2px 2px 0 0" }} />
      <span className="k">
        <Link href={`?adAccount=${a.metaId}`} style={{ textDecoration: "none" }} title={`Filter to ${a.name}`}>
          {a.name}
        </Link>
        {showSingleClientBadge && (
          <span className="badge accent" style={{ fontSize: 9 }}>single client view</span>
        )}
      </span>
      <span className="v accent">{inr(a.spendInr)}</span>
      <span className="d muted">
        {a.metaId} · {a.currency} ·{" "}
        <span className={`badge ${a.status === "ACTIVE" ? "good" : "warn"}`}>{a.status}</span>
      </span>
      <span className="d mono">{a.campaigns} camp · {a.ads} ads</span>
      <span className="d faint" style={{ fontSize: 11 }}>
        balance (due) {a.balance != null ? <b className="mono">{a.currency} {Number(a.balance).toLocaleString("en-IN")}</b> : "— (not pulled yet)"}
      </span>
      <span className="d faint" style={{ fontSize: 11 }}>
        pulled {a.lastPulledAt ? a.lastPulledAt.slice(5, 16).replace("T", " ") + " IST" : "never"}
      </span>
    </div>
  );
}
