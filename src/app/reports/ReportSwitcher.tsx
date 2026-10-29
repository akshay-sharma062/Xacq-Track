"use client";

import { useCallback, useEffect, useState } from "react";
import { inr, pct, Thumbnail } from "../components/ui";

type Key =
  | "funnel"
  | "ad_perf"
  | "wasted_spend"
  | "new_vs_old"
  | "meta_vs_track"
  | "source_mix"
  | "weekly";

const KEYS: { key: Key; label: string }[] = [
  { key: "funnel", label: "Funnel" },
  { key: "ad_perf", label: "Ad performance" },
  { key: "wasted_spend", label: "Wasted spend" },
  { key: "new_vs_old", label: "New vs old" },
  { key: "meta_vs_track", label: "Meta vs Track" },
  { key: "source_mix", label: "Source mix" },
  { key: "weekly", label: "Weekly summary" },
];

/**
 * Client-side report switcher. Fetches /api/reports?key=…&model=…&window=…
 * and renders the active report. CSV/Excel export re-requests the same URL
 * with ?export=csv|excel and opens the attachment.
 */
export function ReportSwitcher() {
  const [key, setKey] = useState<Key>("funnel");
  const [model, setModel] = useState("last_paid_click");
  const [winDays, setWinDays] = useState(30);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const clientId =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("client") : null;

  const load = useCallback(() => {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ key, model, window: String(winDays) });
    if (clientId) params.set("client", clientId);
    fetch(`/api/reports?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        setData(j.data ?? j);
        if (j.error) setErr(j.error);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [key, model, winDays, clientId]);

  useEffect(() => {
    load();
  }, [load]);

  function exportAs(fmt: "csv" | "excel") {
    const params = new URLSearchParams({ key, model, window: String(winDays), export: fmt });
    if (clientId) params.set("client", clientId);
    window.open(`/api/reports?${params.toString()}`, "_blank");
  }

  return (
    <div className="card mb">
      <div className="row spread mb">
        <div className="switch">
          {KEYS.map((k) => (
            <button key={k.key} className={key === k.key ? "on" : ""} onClick={() => setKey(k.key)}>
              {k.label}
            </button>
          ))}
        </div>
        <div className="row">
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="last_paid_click">last paid click</option>
            <option value="first_click">first click</option>
            <option value="linear">linear</option>
            <option value="lead_source">lead source</option>
          </select>
          <select value={winDays} onChange={(e) => setWinDays(Number(e.target.value))}>
            <option value={7}>7d window</option>
            <option value={14}>14d window</option>
            <option value={30}>30d window</option>
            <option value={60}>60d window</option>
          </select>
          <button className="btn sm" onClick={() => exportAs("csv")}>
            CSV
          </button>
          <button className="btn sm" onClick={() => exportAs("excel")}>
            Excel
          </button>
        </div>
      </div>

      {loading ? <div className="empty">Loading…</div> : null}
      {err ? <div className="badge bad">{err}</div> : null}

      {data != null && !loading ? renderReport(key, data, winDays) : null}
    </div>
  );
}

function renderReport(key: Key, data: any, winDays: number) {
  switch (key) {
    case "funnel":
      return (
        <FunnelView data={data} windowDays={winDays} />
      );
    case "ad_perf":
      return (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Leads</th>
              <th style={{ textAlign: "right" }}>Sales</th>
              <th style={{ textAlign: "right" }}>Revenue</th>
              <th style={{ textAlign: "right" }}>Profit</th>
              <th style={{ textAlign: "right" }}>ROAS</th>
            </tr>
          </thead>
          <tbody>
            {(data as any[]).map((r) => (
              <tr key={r.adId}>
                <td>
                  <Thumbnail url={r.thumbnail} name={r.adName} />
                </td>
                <td style={{ textAlign: "right" }} className="mono">{inr(r.spendInr)}</td>
                <td style={{ textAlign: "right" }}>{r.leads}</td>
                <td style={{ textAlign: "right" }}>{r.sales}</td>
                <td style={{ textAlign: "right" }} className="good mono">{inr(r.revenueInr)}</td>
                <td style={{ textAlign: "right" }} className={`mono ${r.profitInr >= 0 ? "good" : "bad"}`}>{inr(r.profitInr)}</td>
                <td style={{ textAlign: "right" }} className="mono">{Number.isFinite(r.roas) ? r.roas.toFixed(2) + "×" : "∞"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "wasted_spend":
      return (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th style={{ textAlign: "right" }}>Spend</th>
              <th style={{ textAlign: "right" }}>Sales</th>
            </tr>
          </thead>
          <tbody>
            {(data as any[]).length === 0 && (
              <tr><td colSpan={3} className="good">No wasted spend above threshold 🎉</td></tr>
            )}
            {(data as any[]).map((r) => (
              <tr key={r.adId}>
                <td>
                  <Thumbnail url={r.thumbnail} name={r.adName} />
                </td>
                <td style={{ textAlign: "right" }} className="mono bad">{inr(r.spendInr)}</td>
                <td style={{ textAlign: "right" }} className="muted">{r.sales}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "new_vs_old":
      return (
        <div className="grid cols-2">
          <StatBox label="New leads (created in range)" value={`${data.newSales} sales`} sub={inr(data.newRevenueInr)} />
          <StatBox label="Old leads (pre-range)" value={`${data.oldSales} sales`} sub={inr(data.oldRevenueInr)} />
        </div>
      );
    case "meta_vs_track":
      return (
        <table className="tbl">
          <thead>
            <tr>
              <th>Ad</th>
              <th style={{ textAlign: "right" }}>Meta conversions</th>
              <th style={{ textAlign: "right" }}>Our conversions</th>
              <th style={{ textAlign: "right" }}>Delta</th>
            </tr>
          </thead>
          <tbody>
            {(data as any[]).map((r) => (
              <tr key={r.adId}>
                <td>
                  <Thumbnail url={r.thumbnail ?? undefined} name={r.adName} />
                </td>
                <td style={{ textAlign: "right" }}>{r.metaConversions}</td>
                <td style={{ textAlign: "right" }}>{r.ourConversions}</td>
                <td style={{ textAlign: "right" }} className={r.over ? "warn" : "good"}>
                  {r.over ? "over-reported" : "under-reported"} ({r.delta})
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "source_mix":
      return (
        <div className="grid cols-4">
          <StatBox label="Instant Form" value={String(data.instantForm)} />
          <StatBox label="Landing page" value={String(data.landingPage)} />
          <StatBox label="Organic" value={String(data.organic)} />
          <StatBox label="Unknown" value={String(data.unknown)} />
        </div>
      );
    case "weekly":
      return (
        <div className="stack">
          <FunnelView data={data.funnel} windowDays={7} />
          <div>
            <h4>Top ads this week</h4>
            <table className="tbl">
              <tbody>
                {(data.topAds ?? []).map((r: any) => (
                  <tr key={r.adId}>
                    <td>{r.adName}</td>
                    <td style={{ textAlign: "right" }} className="mono">{inr(r.spendInr)}</td>
                    <td style={{ textAlign: "right" }}>{r.sales}</td>
                    <td style={{ textAlign: "right" }} className="good mono">{inr(r.revenueInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    default:
      return <pre>{JSON.stringify(data, null, 2)}</pre>;
  }
}

function StatBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="stat">
        <span className="k">{label}</span>
        <span className="v">{value}</span>
        {sub ? <span className="d muted">{sub}</span> : null}
      </div>
    </div>
  );
}

function FunnelView({ data, windowDays }: { data: any; windowDays: number }) {
  if (!data) return null;
  const steps: [string, number, number][] = [
    ["Leads", data.leads, data.leads],
    ["Registered", data.registered, data.leads],
    ["Attended", data.attended, data.leads],
    ["Calls", data.callsBooked, data.leads],
    ["Sales", data.sales, data.leads],
  ];
  return (
    <div>
      <div className="row spread muted mb" style={{ fontSize: 12 }}>
        <span>
          Spend {inr(data.spendInr)} · Revenue {inr(data.revenueInr)} (net of {inr(data.refundsInr)} refunds) · ROI {pct(data.roi)}
        </span>
        <span>last-paid-click · {windowDays}d window</span>
      </div>
      <div className="grid cols-5" style={{ marginBottom: 12 }}>
        {steps.map(([label, val]) => (
          <div key={label} className="card" style={{ textAlign: "center", padding: 10 }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{val}</div>
            <div className="faint" style={{ fontSize: 11 }}>{label}</div>
          </div>
        ))}
      </div>
      <div className="row muted" style={{ fontSize: 12 }}>
        <span>Cost/lead {inr(data.costPerLead)}</span>
        <span>Cost/sale {inr(data.costPerSale)}</span>
        <span>Show-up {pct(data.showUpRate)}</span>
        <span>Close {pct(data.closeRate)}</span>
      </div>
    </div>
  );
}
