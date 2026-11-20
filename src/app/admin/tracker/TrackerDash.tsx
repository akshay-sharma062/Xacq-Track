"use client";

import { useCallback, useEffect, useState } from "react";
import { Stat, BarChart, SectionTitle, fmtNum, ist } from "@/app/components/ui";

/**
 * D-17 — the tracker dashboard panel (client). Renders the overview cards +
 * charts + the visitor table + the IP analytics tab, and — when a specific
 * project is scoped — the install snippet + the active/inactive toggle.
 *
 * Fetches from the admin API (admin_tracker-gated):
 *   overview: GET /api/admin/tracker/overview?window=
 *   project:  GET /api/admin/tracker/<id>?window=
 *   visitors: GET /api/admin/tracker/visitors?project=<id|all>&…
 *   ip:       GET /api/admin/tracker/ip?ip=<suffix>&project=<id|all>
 *   status:   POST /api/admin/tracker/<id>/status
 *
 * The IP column is the (possibly masked) value the API returned — a
 * non-owner/admin role sees "1.2.3.xxx" server-side; the `masked` flag
 * drives a badge so the PO knows why the full IP is hidden.
 */
interface Dash {
  totalPageViews: number;
  uniqueVisitors: number;
  returningVisitors: number;
  newVisitors: number;
  todaysVisits: number;
  uniqueIps: number;
  // MVP parity: the lead capture KPIs (device-track tab).
  totalLeads: number;
  todayLeads: number;
  conversionRate: number;
  recentLeads: {
    visitorId: string;
    deviceType: string | null;
    browserName: string | null;
    osName: string | null;
    ipCountry: string | null;
    ipCity: string | null;
    pageUrl: string | null;
    leadSource: string | null;
    timestamp: string;
  }[];
  visitsByDay: { label: string; value: number }[];
  deviceDist: { label: string; value: number }[];
  browserDist: { label: string; value: number }[];
  osDist: { label: string; value: number }[];
  countryDist: { label: string; value: number }[];
  newVsReturning: { label: string; value: number }[];
}
interface VRow {
  visitorId: string;
  ip: string | null;
  deviceType: string | null;
  browserName: string | null;
  osName: string | null;
  ipCountry: string | null;
  ipCity: string | null;
  firstSeen: string;
  lastSeen: string;
  totalVisits: number;
  kind: "new" | "returning";
}
interface PageResp {
  rows: VRow[];
  total: number;
  page: number;
  pageSize: number;
  masked: boolean;
}

function Dist({ title, data, color }: { title: string; data: { label: string; value: number }[]; color?: string }) {
  const top = data.slice(0, 8);
  return (
    <div className="card">
      <SectionTitle>{title}</SectionTitle>
      <BarChart data={top.map((d) => ({ label: d.label, value: d.value }))} height={120} color={color} />
    </div>
  );
}

export function TrackerDash({
  projectId,
  client,
  title,
}: {
  projectId?: string;
  /** The client id the Topbar client switcher picked (the "filter by
   *  client" axis). Forwarded to the overview/visitors/ip/export fetches;
   *  undefined = the all-clients aggregate. */
  client?: string;
  title: string;
}) {
  const [dash, setDash] = useState<Dash | null>(null);
  const [snippet, setSnippet] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [windowDays, setWindowDays] = useState(30);

  // visitor table state
  const [page, setPage] = useState(1);
  const [vp, setVp] = useState<PageResp | null>(null);
  const [vSearch, setVSearch] = useState("");
  const [vDevice, setVDevice] = useState("");
  const [vCountry, setVCountry] = useState("");
  const [vKind, setVKind] = useState("");
  const [openVisitor, setOpenVisitor] = useState<string | null>(null);

  // ip analytics state
  const [ipQuery, setIpQuery] = useState("");
  const [ipRes, setIpRes] = useState<{
    ip: string | null; eventCount: number; uniqueVisitors: number;
    firstSeen: string | null; lastSeen: string | null;
    deviceBreakdown: { label: string; value: number }[];
  } | null>(null);

  const load = useCallback(() => {
    // The ?client= filter (the "by client" axis) forwards into the all-projects
    // overview; a single-project drill-down is itself already scoped.
    const url = projectId
      ? `/api/admin/tracker/${projectId}?window=${windowDays}`
      : `/api/admin/tracker/overview?window=${windowDays}${client ? `&client=${client}` : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        setDash(j.dashboard ?? null);
        if (j.snippet) setSnippet(j.snippet);
        if (j.project?.status) setStatus(j.project.status);
      })
      .catch(() => {});
  }, [projectId, client, windowDays]);

  useEffect(load, [load]);

  const vLoad = useCallback(() => {
    const p = new URLSearchParams();
    if (projectId) p.set("project", projectId);
    if (client) p.set("client", client);
    if (vSearch.trim()) p.set("search", vSearch.trim());
    if (vDevice) p.set("device", vDevice);
    if (vCountry) p.set("country", vCountry);
    if (vKind) p.set("kind", vKind);
    p.set("page", String(page));
    fetch(`/api/admin/tracker/visitors?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => setVp(j))
      .catch(() => {});
  }, [projectId, client, vSearch, vDevice, vCountry, vKind, page]);

  useEffect(() => {
    vLoad();
  }, [vLoad]);

  const iLoad = useCallback(() => {
    if (!ipQuery.trim()) {
      setIpRes(null);
      return;
    }
    const p = new URLSearchParams({ ip: ipQuery.trim() });
    if (projectId) p.set("project", projectId);
    if (client) p.set("client", client);
    fetch(`/api/admin/tracker/ip?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => setIpRes(j))
      .catch(() => setIpRes(null));
  }, [ipQuery, projectId, client]);

  useEffect(() => {
    iLoad();
  }, [iLoad]);

  async function copySnippet() {
    if (!snippet) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the snippet is selectable */
    }
  }

  async function toggleStatus() {
    if (!projectId || !status) return;
    const next = status === "active" ? "inactive" : "active";
    const r = await fetch(`/api/admin/tracker/${projectId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    if (r.ok) setStatus(next);
  }

  // The CSV export (admin_tracker-gated, IP full): link out to the route.
  // The ?client= filter (the "by client" axis) carries through too.
  const exportUrl = `/api/admin/tracker/export${projectId ? `?project=${projectId}` : ""}${!projectId && client ? `?client=${client}` : ""}`;
  const deviceOpts = Array.from(new Set((vp?.rows ?? []).map((r) => r.deviceType).filter(Boolean))) as string[];
  const countryOpts = Array.from(new Set((vp?.rows ?? []).map((r) => r.ipCountry).filter(Boolean))) as string[];

  const maxPage = vp ? Math.max(1, Math.ceil(vp.total / vp.pageSize)) : 1;

  return (
    <div className="stack" style={{ gap: 16 }}>
      {/* window filter */}
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <span className="muted" style={{ fontSize: 12 }}>Window</span>
        <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))} style={{ minWidth: 120 }}>
          <option value={7}>Last 7d</option>
          <option value={14}>Last 14d</option>
          <option value={30}>Last 30d</option>
          <option value={90}>Last 90d</option>
        </select>
        {projectId ? <a className="faint" style={{ fontSize: 12 }} href={`/api/tracker`}>{title}</a> : null}
      </div>

      {/* the per-project install snippet + status toggle (only a single-project view) */}
      {projectId && snippet ? (
        <div className="card" style={{ background: "var(--panel-2)" }}>
          <div className="row spread" style={{ marginBottom: 8 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 13 }}>Install snippet</h3>
              <div className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                Paste this into the FlexiFunnels custom-JS slot. No secret — only the public project id + base URL.
              </div>
            </div>
            <button className="btn sm" onClick={copySnippet}>{copied ? "copied ✓" : "copy"}</button>
          </div>
          <code className="mono" style={{ fontSize: 11, wordBreak: "break-all", userSelect: "all", display: "block" }}>
            {snippet}
          </code>
          <div className="row mt" style={{ gap: 8 }}>
            <span className={`badge ${status === "active" ? "good" : "bad"}`}>{status}</span>
            <button className="btn sm" onClick={toggleStatus}>
              {status === "active" ? "Disable (ingest → 204)" : "Enable"}
            </button>
            {status === "inactive" ? (
              <span className="faint" style={{ fontSize: 11 }}>
                While inactive, /api/tracker/ingest returns 204 and writes nothing (history is kept).
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* overview cards */}
      {dash ? (
        <div className="grid cols-4">
          <Stat label="Total Page Views" value={fmtNum(dash.totalPageViews)} tone="accent" />
          <Stat label="Unique Visitors" value={fmtNum(dash.uniqueVisitors)} tone="good" />
          <Stat label="Returning" value={fmtNum(dash.returningVisitors)} sub="totalVisits > 1" />
          <Stat label="New" value={fmtNum(dash.newVisitors)} sub="totalVisits = 1" />
          <Stat label={`Today's Visits`} value={fmtNum(dash.todaysVisits)} sub="IST" />
          <Stat label="Unique IPs" value={fmtNum(dash.uniqueIps)} sub="distinct, non-null" />
          {/* MVP parity: the LEAD capture KPIs (device-track tab). */}
          <Stat label="Leads (total)" value={fmtNum(dash.totalLeads)} tone="good" sub={`${dash.conversionRate}% conversion`} />
          <Stat label={`Today's Leads`} value={fmtNum(dash.todayLeads)} sub="IST" />
          <Stat label="New vs Returning" value={`${fmtNum(dash.newVisitors)} / ${fmtNum(dash.returningVisitors)}`} />
          <Stat label="Window" value={`${windowDays}d`} sub="time-series scope" />
        </div>
      ) : null}

      {/* the recent-leads table (MVP parity: the last 50 lead events) */}
      {dash && dash.recentLeads?.length ? (
        <div className="card">
          <SectionTitle>Recent leads (last 50)</SectionTitle>
          <table className="tbl">
            <thead>
              <tr>
                <th>When (IST)</th>
                <th>Visitor</th>
                <th>Source</th>
                <th>Device</th>
                <th>Location</th>
                <th>Page</th>
              </tr>
            </thead>
            <tbody>
              {dash.recentLeads.map((l, i) => (
                <tr key={i}>
                  <td className="faint" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{ist(l.timestamp)}</td>
                  <td className="mono" style={{ fontSize: 11 }}>{l.visitorId.slice(0, 12)}…</td>
                  <td>
                    <span className={`badge ${l.leadSource === "thankyou" ? "good" : "accent"}`}>
                      {l.leadSource || "lead"}
                    </span>
                  </td>
                  <td>{[l.deviceType, l.browserName].filter(Boolean).join(" · ") || "—"}</td>
                  <td>{[l.ipCountry, l.ipCity].filter(Boolean).join(" · ") || "—"}</td>
                  <td className="mono" style={{ fontSize: 10, wordBreak: "break-all" }}>{l.pageUrl || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* charts */}
      {dash ? (
        <div className="grid cols-3">
          <div className="card" style={{ gridColumn: "span 3" }}>
            <SectionTitle>Visits over time (last {windowDays}d)</SectionTitle>
            <BarChart data={dash.visitsByDay} height={140} />
          </div>
          <Dist title="Device" data={dash.deviceDist} />
          <Dist title="Browser" data={dash.browserDist} />
          <Dist title="OS" data={dash.osDist} />
          <Dist title="Country (top 10)" data={dash.countryDist} />
          <Dist title="New vs Returning" data={dash.newVsReturning} color="var(--good)" />
        </div>
      ) : null}

      {/* IP analytics tab */}
      <div className="card">
        <SectionTitle>IP analytics</SectionTitle>
        <div className="row" style={{ gap: 8, marginBottom: 10 }}>
          <input
            placeholder="IP (suffix search, e.g. 1.2.3 or ::1)"
            value={ipQuery}
            onChange={(e) => setIpQuery(e.target.value)}
            style={{ width: 300, fontSize: 12 }}
          />
          <span className="faint" style={{ fontSize: 11 }}>the unique-visitor + device breakdown for that IP</span>
        </div>
        {ipRes && ipRes.eventCount > 0 ? (
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <Stat label="IP" value={<span className="mono" style={{ fontSize: 12 }}>{ipRes.ip}</span>} />
            <Stat label="Events" value={fmtNum(ipRes.eventCount)} />
            <Stat label="Unique visitors" value={fmtNum(ipRes.uniqueVisitors)} tone="good" />
            <Stat label="First / Last seen" value={`${ist(ipRes.firstSeen)} → ${ist(ipRes.lastSeen)}`} sub="" />
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Device breakdown</div>
              <div className="row" style={{ gap: 6 }}>
                {ipRes.deviceBreakdown.map((d) => (
                  <span key={d.label} className="badge accent">{d.label}: {d.value}</span>
                ))}
              </div>
            </div>
          </div>
        ) : ipRes ? (
          <div className="empty">no events for that IP yet</div>
        ) : null}
      </div>

      {/* the visitor table */}
      <div className="card">
        <div className="row spread" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Visitors {vp?.masked ? <span className="badge warn" style={{ marginLeft: 8 }}>IP masked (non-admin role)</span> : null}</h3>
          <a className="btn sm" href={exportUrl}>export CSV</a>
        </div>

        <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <input
            placeholder="search IP suffix or visitorId"
            value={vSearch}
            onChange={(e) => { setVSearch(e.target.value); setPage(1); }}
            style={{ width: 220, fontSize: 12 }}
          />
          <select value={vDevice} onChange={(e) => { setVDevice(e.target.value); setPage(1); }} style={{ minWidth: 110 }}>
            <option value="">all devices</option>
            {deviceOpts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={vCountry} onChange={(e) => { setVCountry(e.target.value); setPage(1); }} style={{ minWidth: 110 }}>
            <option value="">all countries</option>
            {countryOpts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={vKind} onChange={(e) => { setVKind(e.target.value); setPage(1); }} style={{ minWidth: 120 }}>
            <option value="">new + returning</option>
            <option value="new">new</option>
            <option value="returning">returning</option>
          </select>
        </div>

        {vp && vp.rows.length === 0 ? (
          <div className="empty">no visitors yet — drive a visit (paste the snippet + open a page)</div>
        ) : vp ? (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Visitor</th>
                  <th>IP</th>
                  <th>Device</th>
                  <th>Browser</th>
                  <th>OS</th>
                  <th>Location</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Visits</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {vp.rows.map((r) => (
                  <tr key={r.visitorId} onClick={() => setOpenVisitor(openVisitor === r.visitorId ? null : r.visitorId)} style={{ cursor: "pointer" }}>
                    <td className="mono" style={{ fontSize: 11 }}>{r.visitorId.slice(0, 12)}…</td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.ip}</td>
                    <td>{r.deviceType || "—"}</td>
                    <td>{r.browserName || "—"}</td>
                    <td>{r.osName || "—"}</td>
                    <td>{[r.ipCountry, r.ipCity].filter(Boolean).join(" · ") || "—"}</td>
                    <td className="faint" style={{ fontSize: 11 }}>{ist(r.firstSeen)}</td>
                    <td className="faint" style={{ fontSize: 11 }}>{ist(r.lastSeen)}</td>
                    <td>{r.totalVisits}</td>
                    <td><span className={`badge ${r.kind === "new" ? "good" : "accent"}`}>{r.kind}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* per-visitor detail: that visitorId's events, chronological */}
            {openVisitor ? (
              <DetailDrawer projectId={projectId} visitorId={openVisitor} onClose={() => setOpenVisitor(null)} />
            ) : null}
            <div className="row spread mt" style={{ fontSize: 12 }}>
              <span className="faint">{fmtNum(vp.total)} total · page {vp.page}/{maxPage}</span>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>prev</button>
                <button className="btn sm" disabled={page >= maxPage} onClick={() => setPage((p) => p + 1)}>next</button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The per-visitor detail drawer: that visitorId's events, chronological. */
function DetailDrawer({ projectId, visitorId, onClose }: { projectId?: string; visitorId: string; onClose: () => void }) {
  const [events, setEvents] = useState<any[] | null>(null);
  useEffect(() => {
    const p = new URLSearchParams({ detail: visitorId });
    if (projectId) p.set("project", projectId);
    fetch(`/api/admin/tracker/visitors?${p.toString()}`)
      .then((r) => r.json())
      .then((j) => setEvents(Array.isArray(j?.events) ? j.events : null))
      .catch(() => setEvents(null));
  }, [projectId, visitorId]);
  return (
    <div className="card" style={{ background: "var(--panel-2)", marginTop: 10 }}>
      <div className="row spread mb">
        <h3 style={{ margin: 0, fontSize: 13 }}>Visitor {visitorId} — events (chronological)</h3>
        <button className="btn sm" onClick={onClose}>close</button>
      </div>
      {!events ? (
        <div className="empty">loading…</div>
      ) : events.length === 0 ? (
        <div className="empty">no events</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr><th>When</th><th>Device</th><th>Browser</th><th>OS</th><th>UTM source</th><th>Page</th></tr>
          </thead>
          <tbody>
            {events.map((e: any) => (
              <tr key={e.id}>
                <td className="faint" style={{ fontSize: 11 }}>{ist(e.timestamp)}</td>
                <td>{e.deviceType || "—"}</td>
                <td>{e.browserName || "—"}</td>
                <td>{e.osName || "—"}</td>
                <td>{e.utmSource || "—"}</td>
                <td className="mono" style={{ fontSize: 10, wordBreak: "break-all" }}>{e.pageUrl || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
