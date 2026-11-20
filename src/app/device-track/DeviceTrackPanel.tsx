"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { TrackerDash } from "../admin/tracker/TrackerDash";
import { ist } from "@/app/components/ui";

/**
 * The Device Track panel — the project-management strip (create / enable-
 * disable / copy-snippet / open) + the dashboard (TrackerDash, which reads
 * from the admin tracker APIs). The "filter by client" axis is the Topbar's
 * client switcher (?client=), forwarded into the dashboard; the "filter by
 * project" axis is the ?project= drill-down this strip drives.
 *
 *   GET  /api/admin/tracker          → the project list (with owning client)
 *   POST /api/admin/tracker          → create (name + landing page + client)
 *   POST /api/admin/tracker/<id>/status → enable/disable
 *
 * All admin_tracker-gated (owner/admin) at the API layer.
 */
interface ProjectRow {
  id: string;
  name: string;
  landingPageName: string;
  landingPageUrl: string;
  status: string;
  eventCount: number;
  lastEventAt: string | null;
  clientId: string | null;
  clientName: string | null;
  createdAt: string;
  /** The install script for THIS project (paste into its landing page's
   *  custom-JS slot). Built server-side from the live-host base. */
  snippet?: string;
}

export function DeviceTrackPanel({
  clients,
  projectId,
  client,
}: {
  clients: { id: string; name: string }[];
  projectId?: string;
  /** The Topbar client switcher's current client (undefined = all clients). */
  client?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [base, setBase] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", landingPageName: "", landingPageUrl: "", clientId: "" });

  const load = useCallback(() => {
    fetch("/api/admin/tracker")
      .then((r) => r.json())
      .then((j) => {
        setProjects(Array.isArray(j?.projects) ? j.projects : []);
        if (typeof j?.base === "string") setBase(j.base);
      })
      .catch(() => setProjects([]));
  }, []);
  useEffect(load, [load]);

  // "Filter by client" axis: when the Topbar client switcher picks a client
  // (the `client` prop), the list narrows to THAT client's projects (each
  // with its install script). Absent / "all" = every project.
  const visibleProjects = (projects ?? []).filter(
    (p) => !client || p.clientId === client
  );
  const selectedClientName = client
    ? (clients.find((c) => c.id === client)?.name ?? client)
    : null;

  async function copySnippet(p: ProjectRow) {
    if (!p.snippet) return;
    try {
      await navigator.clipboard.writeText(p.snippet);
      setCopiedId(p.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* clipboard blocked — the snippet is selectable */
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const body: Record<string, string> = { ...form };
    if (!form.clientId) delete body.clientId;
    const r = await fetch("/api/admin/tracker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      // No implicit clipboard write: the snippet is DISPLAYED in the new
      // project's card (selectable + a copy button) — the PO reads/copies
      // it deliberately. Refresh the list so the new project's card (with
      // its visible script) shows up.
      setForm({ name: "", landingPageName: "", landingPageUrl: "", clientId: "" });
      setMsg(`created '${j.name}' — its install script is in the card above; paste it into the FlexiFunnels custom-JS slot`);
      load();
    } else {
      setMsg(`create failed: ${j.error ?? r.status}`);
    }
  }

  async function toggle(p: ProjectRow) {
    const next = p.status === "active" ? "inactive" : "active";
    await fetch(`/api/admin/tracker/${p.id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    load();
  }

  // The ?project= drill-down (the Topbar's ?client= is the client filter).
  const setProject = (id: string | null) => {
    const p = new URLSearchParams();
    if (id) p.set("project", id);
    if (client) p.set("client", client);
    router.push(`${pathname}?${p.toString()}`);
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      {/* project management + the per-client install-script strip */}
      <div className="card">
        <div className="row spread" style={{ alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>
            {selectedClientName ? `Tracking projects — ${selectedClientName}` : "Tracking projects (all clients)"}
          </h3>
          <span className="faint" style={{ fontSize: 11 }}>
            pick a client in the filter above → its tracking projects + the install script show here
          </span>
        </div>

        {visibleProjects.length === 0 ? (
          <div className="empty" style={{ marginTop: 8 }}>
            {client ? `no tracking projects for ${selectedClientName} yet — create one below` : "no tracking projects yet — create one below"}
          </div>
        ) : (
          <div className="stack" style={{ gap: 10, marginTop: 10 }}>
            {visibleProjects.map((p) => (
              <div key={p.id} className="card" style={{ background: "var(--panel-2)" }}>
                {/* the project's identity + management */}
                <div className="row spread" style={{ alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{p.name}</strong>
                    <span className="faint" style={{ fontSize: 11 }}>· {p.landingPageName}</span>
                    <span className={`badge ${p.status === "active" ? "good" : "warn"}`}>{p.status}</span>
                    {!client ? (
                      p.clientName
                        ? <span className="badge accent">{p.clientName}</span>
                        : <span className="faint">unassigned client</span>
                    ) : null}
                    <span className="faint" style={{ fontSize: 11 }}>
                      {p.eventCount} events{p.lastEventAt ? ` · last ${ist(p.lastEventAt)}` : ""}
                    </span>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn sm" onClick={() => toggle(p)}>
                      {p.status === "active" ? "disable" : "enable"}
                    </button>
                    <button className="btn sm" onClick={() => setProject(p.id)}>analytics</button>
                  </div>
                </div>

                {/* the install script — VISIBLE + copyable (paste into the
                    landing page's custom-JS / FlexiFunnels slot) */}
                <div style={{ marginTop: 8 }}>
                  <div className="row spread" style={{ alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 11 }}>
                      install script → paste into <span className="mono">{p.landingPageName}</span> ({p.landingPageUrl})
                    </span>
                    <button className="btn sm" onClick={() => copySnippet(p)}>
                      {copiedId === p.id ? "copied ✓" : "copy script"}
                    </button>
                  </div>
                  <code className="mono" style={{
                    display: "block",
                    fontSize: 11,
                    marginTop: 6,
                    padding: "8px 10px",
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                    borderLeft: "3px solid var(--accent)",
                    borderRadius: 6,
                    wordBreak: "break-all",
                    userSelect: "all",
                    whiteSpace: "pre-wrap",
                  }}>
                    {p.snippet || `loading snippet… ${base ? `(base: ${base})` : ""}`}
                  </code>
                </div>
              </div>
            ))}
          </div>
        )}

        {projectId ? (
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <span className="muted" style={{ fontSize: 12 }}>
              viewing project <strong>{projectId}</strong> (a single-project view)
            </span>
            <button className="btn sm" onClick={() => setProject(null)}>← all projects</button>
          </div>
        ) : null}

        {/* create form */}
        <form onSubmit={create} className="row" style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <input
            placeholder="project name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={{ width: 160, fontSize: 12 }}
            required
          />
          <input
            placeholder="landing page name"
            value={form.landingPageName}
            onChange={(e) => setForm({ ...form, landingPageName: e.target.value })}
            style={{ width: 160, fontSize: 12 }}
            required
          />
          <input
            type="url"
            placeholder="https://… landing URL"
            value={form.landingPageUrl}
            onChange={(e) => setForm({ ...form, landingPageUrl: e.target.value })}
            style={{ width: 260, fontSize: 12 }}
            required
          />
          <select
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            style={{ minWidth: 140, fontSize: 12 }}
          >
            <option value="">no client (all)</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button className="btn sm" type="submit">+ create project</button>
        </form>
        {msg ? (
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{msg}</div>
        ) : null}
      </div>

      {/* the dashboard (all-projects aggregate, or the single-project view) */}
      <TrackerDash
        projectId={projectId}
        client={client}
        title={projectId ? `project ${projectId}` : "all projects"}
      />
    </div>
  );
}
