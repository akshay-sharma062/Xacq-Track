import { Topbar } from "./components/Topbar";
import { Stat, BarChart, Meter, Thumbnail, inr, pct, SectionTitle } from "./components/ui";
import { getSession, resolveClient } from "@/lib/api-utils";
import { dashboardFor } from "@/lib/dashboard";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

/**
 * Screen 1 — Dashboard. Funnel KPIs, spend by day, top ads, source mix, all
 * scoped to the visible client. Every number is live from the DB (spec 9).
 */
export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Dashboard" crumb="Not signed in" />
        <div className="card empty">No demo user configured. Set DEMO_USER in .env.</div>
      </>
    );
  }
  const clientId = await resolveClient(s, null);
  if (!clientId) {
    return (
      <>
        <Topbar title="Dashboard" crumb={s.name} />
        <div className="card empty">No visible client for this user.</div>
      </>
    );
  }

  const d = await dashboardFor(prisma, clientId, "last_paid_click", 30);
  const f = d.funnel;

  return (
    <>
      <Topbar title="Dashboard" crumb={`${s.name} · last 30 days`} />

      <div className="grid cols-4 mb">
        <Stat label="Ad spend (INR)" value={inr(f.spendInr)} sub={`${inr(f.revenueInr)} revenue · ROI ${pct(f.roi)}`} tone="accent" />
        <Stat label="Leads" value={d.counts.leads} sub={`${f.registered} registered · ${f.attended} attended`} />
        <Stat label="Sales (net)" value={d.funnel.sales} sub={`${inr(f.revenueInr)} revenue, ${inr(f.refundsInr)} refunded`} tone="good" />
        <Stat label="Cost / sale" value={inr(f.costPerSale)} sub={`show-up ${pct(f.showUpRate)} · close ${pct(f.closeRate)}`} tone={f.roi >= 0 ? "good" : "warn"} />
      </div>

      <div className="grid cols-2 mb">
        <div className="card">
          <SectionTitle right={<Link className="faint" href="/reports">All reports →</Link>}>
            Daily ad spend (INR)
          </SectionTitle>
          <BarChart data={d.spendByDay} color="var(--accent)" unit=" " />
        </div>
        <div className="card">
          <SectionTitle>Lead source mix</SectionTitle>
          <div className="stack">
            <Meter label="Meta Instant Form" value={d.mix.instantForm} max={Math.max(d.mix.total, 1)} tone="accent" />
            <Meter label="Landing page (ad click)" value={d.mix.landingPage} max={Math.max(d.mix.total, 1)} tone="good" />
            <Meter label="Organic" value={d.mix.organic} max={Math.max(d.mix.total, 1)} tone="warn" />
            <Meter label="Unknown / no match" value={d.mix.unknown} max={Math.max(d.mix.total, 1)} tone="bad" />
          </div>
        </div>
      </div>

      <div className="card">
        <SectionTitle right={<Link className="faint" href="/reports?key=ad_perf">Ad table →</Link>}>
          Top ads by spend (30d, last-click)
        </SectionTitle>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 64 }}>Ad</th>
              <th>Name</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Sales</th>
              <th style={{ textAlign: "right" }}>Revenue</th>
              <th style={{ textAlign: "right" }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {d.topAds.map((r) => (
              <tr key={r.adId}>
                <td><Thumbnail url={r.thumbnail} name={r.adName} /></td>
                <td>{r.adName}</td>
                <td style={{ textAlign: "right" }} className="mono">{inr(r.spendInr)}</td>
                <td style={{ textAlign: "right" }}>{r.sales}</td>
                <td style={{ textAlign: "right" }} className="good">{inr(r.revenueInr)}</td>
                <td style={{ textAlign: "right" }} className={r.roas >= 1 ? "good" : "bad"}>
                  {Number.isFinite(r.roas) ? r.roas.toFixed(1) + "×" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row mt">
        <Link className="btn" href="/leads">Open lead list</Link>
        <Link className="btn" href="/pipeline">Pipeline</Link>
        <Link className="btn" href="/meta">Meta pull + CAPI</Link>
      </div>
    </>
  );
}
