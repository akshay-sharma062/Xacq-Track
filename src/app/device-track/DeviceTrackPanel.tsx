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
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", landingPageName: "", landingPageUrl: "", clientId: "" });

  const load = useCallback(() => {
    fetch("/api/admin/tracker")
      .then((r) => r.json())
      .then((j) => setProjects(Array.isArray(j?.projects) ? j.projects : []))
      .catch(() => setProjects([]));
  }, []);
  useEffect(load, [load]);

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
      setForm({ name: "", landingPageName: "", landingPageUrl: "", clientId: "" });
      setMsg(`created '${j.name}' — copy the snippet below into the FlexiFunnels custom-JS slot`);
      if (j.snippet) navigator.clipboard.writeText(j.snippet).catch(() => {});
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
      {/* project management strip */}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tracking projects (all clients)</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Project</th>
              <th>Landing page</th>
              <th>Client</th>
              <th>Status</th>
              <th>Events</th>
              <th>Last event</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(projects ?? []).length === 0 && (
              <tr><td colSpan={7} className="empty">no tracking projects yet — create one below</td></tr>
            )}
            {(projects ?? []).map((p) => (
              <tr key={p.id}>
                <td><strong>{p.name}</strong></td>
                <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{p.landingPageUrl}</td>
                <td>{p.clientName ? <span className="badge accent">{p.clientName}</span> : <span className="faint">unassigned</span>}</td>
                <td>
                  <button className="btn sm" onClick={() => toggle(p)}>
                    {p.status === "active" ? "disable" : "enable"}
                  </button>
                </td>
                <td>{p.eventCount}</td>
                <td className="faint" style={{ fontSize: 11 }}>{p.lastEventAt ? ist(p.lastEventAt) : "—"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn sm" onClick={() => setProject(p.id)}>view</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

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
