"use client";

import { useCallback, useEffect, useState } from "react";
import { WebhookBaseSource } from "@/lib/integrations";

/**
 * D-13 — the integrations admin panel (client component). Talks to the
 * admin-only /api/admin/{keys,webhooks} routes. Security posture, faithfully
 * mirrored from the API:
 *
 *   - API keys: the DB stores ONLY the SHA-256 hash. The plain key appears
 *     exactly once — in the create response — and is revealed here behind a
 *     mandatory "show me" confirm, with a copy-now + "cannot be retrieved
 *     later" warning. The list/GET never returns a key value.
 *
 *   - Webhook connections: each row carries its OWN generated secret
 *     (reversible-stored so HMAC gateways can verify). Same show-once
 *     treatment. The list response deliberately omits the secret.
 *
 *   - Revoke is a soft row stamp (revokedAt / active=false), never a delete:
 *     the connection log + audit trail stay intact, lastReceivedAt stays
 *     visible.
 *
 * The FlexiFunnels quick-action card renders the two paste targets the PO
 * named (Form Settings → Webhooks for leads; Products → Product Rules →
 * Webhook for purchases) as UI-only guidance — the ticket keeps it
 * UI-only, it does not drive any FlexiFunnels config itself.
 */

// ---- API response shapes (mirror the route files) ------------------------
interface KeyRow {
  id: string;
  label: string;
  clientId: string | null;
  purpose: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}
interface WebhookRow {
  id: string;
  clientId: string;
  platform: string;
  label: string;
  inboundUrl: string;
  active: boolean;
  createdAt: string;
  lastReceivedAt: string | null;
}
interface ClientOpt {
  id: string;
  name: string;
}
interface PlatformOpt {
  platform: string;
  label: string;
}
interface ConnLogRow {
  id: string;
  receivedAt: string;
  status: string;
  error: string | null;
  payloadHash: string;
}


const PURPOSES = [
  { value: "ingest", label: "ingest" },
  { value: "api", label: "api" },
  { value: "webhook_verify", label: "webhook_verify" },
];

function ClientName({ id, clients }: { id: string | null; clients: ClientOpt[] }) {
  if (id == null) return <span className="badge accent">workspace</span>;
  const c = clients.find((x) => x.id === id);
  return c ? <span>{c.name}</span> : <span className="mono" style={{ fontSize: 11 }}>{id}</span>;
}

function fmtTs(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** A plain-value "shown once" reveal: hidden until the user confirms, then a
 *  copy-able string with a "cannot be retrieved later" warning. No re-reveal. */
function ShowOnce({ value, kind }: { value: string; kind: "key" | "webhook" }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!revealed) {
    return (
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <span className="badge warn">show-once {kind} available</span>
        <button className="btn primary sm" onClick={() => setRevealed(true)}>
          Reveal {kind} (I understand it's shown once)
        </button>
      </div>
    );
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — user can select the text */
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row spread" style={{ gap: 8 }}>
        <code className="mono" style={{ fontSize: 12, wordBreak: "break-all", userSelect: "all" }}>
          {value}
        </code>
        <button className="btn sm" onClick={copy}>{copied ? "copied ✓" : "copy"}</button>
      </div>
      <span className="warn" style={{ fontSize: 11 }}>
        {copied ? "Copied — " : ""}
        {kind === "key"
          ? "This API key was returned once and is no longer retrievable. Save it now; we only store its SHA-256 hash."
          : "This webhook secret was returned once and is no longer retrievable. Save it now; it is what the provider must echo / sign with."}
      </span>
    </div>
  );
}

export function IntegrationsPanel({
  platforms,
  clients,
  base,
  baseSource,
  baseIsLoopback,
}: {
  platforms: PlatformOpt[];
  clients: ClientOpt[];
  /** D-13a: the base URL NEW connections will be generated against. */
  base: string;
  /** Which tier supplied `base` (explicit / PUBLIC_BASE_URL / NEXT_PUBLIC_BASE_URL / localhost-dev). */
  baseSource: WebhookBaseSource;
  /** True when `base` is a loopback host external providers can't reach. */
  baseIsLoopback: boolean;
}) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [webhooks, setWebhooks] = useState<WebhookRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // One-time reveal state (create response, never re-fetched).
  const [newKey, setNewKey] = useState<{ key: string; id: string } | null>(null);
  const [newHook, setNewHook] = useState<{ secret: string; id: string } | null>(null);

  // Per-row connection-log drawer (payload-hash-only, last 100 — the /logs
  // route returns hashes, never the raw payload).
  const [openLog, setOpenLog] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<Record<string, ConnLogRow[]>>({});

  // Form state.
  const [kLabel, setKLabel] = useState("");
  const [kPurpose, setKPurpose] = useState("api");
  const [kClient, setKClient] = useState<string>(""); // "" = workspace-level
  const [wLabel, setWLabel] = useState("");
  const [wClient, setWClient] = useState<string>(clients[0]?.id ?? "");
  const [wPlatform, setWPlatform] = useState("flexifunnels");

  const load = useCallback(() => {
    setErr(null);
    fetch("/api/admin/keys")
      .then((r) => r.json())
      .then((j) => setKeys(j.keys ?? []))
      .catch((e) => setErr(String(e)));
    fetch("/api/admin/webhooks?client=all")
      .then((r) => r.json())
      .then((j) => setWebhooks(j.webhooks ?? []))
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(load, [load]);

  async function genKey() {
    setErr(null);
    const body: Record<string, string> = { label: kLabel.trim(), purpose: kPurpose };
    if (kClient) body.clientId = kClient;
    const r = await fetch("/api/admin/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? `error ${r.status}`);
      return;
    }
    setNewKey({ key: j.key, id: j.id });
    setKLabel("");
    load();
  }

  async function genHook() {
    setErr(null);
    if (!wClient) {
      setErr("select a client for the webhook connection");
      return;
    }
    const r = await fetch("/api/admin/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: wClient, platform: wPlatform, label: wLabel.trim() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? `error ${r.status}`);
      return;
    }
    setNewHook({ secret: j.secret, id: j.id });
    setWLabel("");
    load();
  }

  async function revokeKey(id: string) {
    const r = await fetch("/api/admin/keys/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(j.error ?? `error ${r.status}`);
    load();
  }

  async function revokeHook(id: string) {
    const r = await fetch("/api/admin/webhooks/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) setErr(j.error ?? `error ${r.status}`);
    load();
  }

  /** Fetch a connection's last-100 logs (payload-hash only — never raw). */
  async function openLogs(id: string) {
    if (openLog === id) {
      setOpenLog(null);
      return;
    }
    if (logsFor[id]) {
      setOpenLog(id); // already fetched — just toggle
      return;
    }
    const r = await fetch(`/api/admin/webhooks/${id}/logs`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setErr(j.error ?? `error ${r.status}`);
      return;
    }
    setLogsFor((m) => ({ ...m, [id]: j.logs ?? [] }));
    setOpenLog(id);
  }

  // The FlexiFunnels quick-action: for each active flexifunnels connection,
  // show the inboundUrl + a "get the secret" hint. The secret is only in the
  // create response (show-once), so a connection that was just created reveals
  // it inline; an older one shows "re-create to get a fresh secret" (the
  // value can't be re-read — by design).
  const ffHooks = (webhooks ?? []).filter((w) => w.platform === "flexifunnels");

  // D-13a: the current-generation base + which tier it came from. Shown in
  // the Webhook-connections header, and BANNERED when it's a loopback host
  // (localhost / 127.0.0.1) — the exact "FlexiFunnels rejects localhost" case.
  const SOURCE_LABEL: Record<WebhookBaseSource, string> = {
    explicit: "injected",
    PUBLIC_BASE_URL: "PUBLIC_BASE_URL",
    NEXT_PUBLIC_BASE_URL: "NEXT_PUBLIC_BASE_URL",
    "localhost-dev": "localhost fallback (no PUBLIC_BASE_URL in .env)",
  };

  return (
    <div className="stack" style={{ gap: 16 }}>
      {err ? <div className="card"><span className="bad" style={{ fontSize: 12 }}>{err}</span></div> : null}

      {baseIsLoopback ? (
        <div className="card" style={{ borderColor: "rgba(245,184,61,0.5)", background: "rgba(245,184,61,0.06)" }}>
          <div className="row spread">
            <div>
              <h3 style={{ margin: 0 }} className="warn">Public base URL not set</h3>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Generated webhook connections will use <code className="mono">{base}</code> — a host an
                external provider (FlexiFunnels, Razorpay, …) cannot reach, so they will reject the
                URL as "incorrect". Set <code className="mono">PUBLIC_BASE_URL</code> in <code>.env</code> to
                the live tunnel subdomain, re-generate the connection (or run{" "}
                <code className="mono">pnpm webhooks:refresh-url</code> to re-point the existing rows),
                and re-verify the subdomain — quick-tunnels rotate on every restart.
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ---------------------------- API KEYS ---------------------------- */}
      <div className="card">
        <div className="row spread" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>API keys</h3>
          <span className="faint" style={{ fontSize: 11 }}>SHA-256 hash stored · plain shown once</span>
        </div>

        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <input placeholder="key label (e.g. CI ingest)" value={kLabel} onChange={(e) => setKLabel(e.target.value)} style={{ width: 180 }} />
          <select value={kPurpose} onChange={(e) => setKPurpose(e.target.value)} style={{ minWidth: 130 }}>
            {PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <select value={kClient} onChange={(e) => setKClient(e.target.value)} style={{ minWidth: 140 }}>
            <option value="">workspace-level</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button className="btn primary sm" onClick={genKey} disabled={!kLabel.trim()}>Generate key</button>
        </div>

        {newKey ? (
          <div className="card" style={{ background: "var(--panel-2)", marginBottom: 10 }}>
            <div className="row spread" style={{ marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>New key</h3>
              <button className="btn sm" onClick={() => setNewKey(null)}>dismiss</button>
            </div>
            <ShowOnce value={newKey.key} kind="key" />
          </div>
        ) : null}

        {keys == null ? (
          <div className="empty">loading…</div>
        ) : keys.length === 0 ? (
          <div className="empty">no API keys yet</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Label</th>
                <th>Scope</th>
                <th>Purpose</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.label}</td>
                  <td><ClientName id={k.clientId} clients={clients} /></td>
                  <td><span className="badge accent">{k.purpose}</span></td>
                  <td className="faint" style={{ fontSize: 12 }}>{fmtTs(k.createdAt)}</td>
                  <td className="faint" style={{ fontSize: 12 }}>{fmtTs(k.lastUsedAt)}</td>
                  <td>
                    {k.revokedAt
                      ? <span className="badge bad">revoked</span>
                      : <span className="badge good">active</span>}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {!k.revokedAt ? (
                      <button className="btn danger sm" onClick={() => revokeKey(k.id)}>revoke</button>
                    ) : (
                      <span className="faint" style={{ fontSize: 11 }}>{fmtTs(k.revokedAt)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ------------------------- WEBHOOK CONNECTIONS --------------------- */}
      <div className="card">
        <div className="row spread" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>Webhook connections</h3>
          <span className="faint" style={{ fontSize: 11 }}>per-connection secret · inboundUrl carries &amp;conn=</span>
        </div>
        <div className="row spread" style={{ marginBottom: 10 }}>
          <span className="faint" style={{ fontSize: 11 }}>
            new connections generated against{" "}
            <code className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>{base}</code>
          </span>
          <span className={`badge ${baseIsLoopback ? "warn" : "good"}`} style={{ fontSize: 11 }}>
            base: {SOURCE_LABEL[baseSource]}{baseIsLoopback ? " (unreachable externally)" : ""}
          </span>
        </div>

        <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
          <input placeholder="label (e.g. FlexiFunnels leads)" value={wLabel} onChange={(e) => setWLabel(e.target.value)} style={{ width: 200 }} />
          <select value={wClient} onChange={(e) => setWClient(e.target.value)} style={{ minWidth: 140 }}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <select value={wPlatform} onChange={(e) => setWPlatform(e.target.value)} style={{ minWidth: 130 }}>
            {platforms.map((p) => (
              <option key={p.platform} value={p.platform}>{p.label}</option>
            ))}
          </select>
          <button className="btn primary sm" onClick={genHook} disabled={!wLabel.trim() || !wClient}>Generate webhook</button>
        </div>

        {newHook ? (
          <div className="card" style={{ background: "var(--panel-2)", marginBottom: 10 }}>
            <div className="row spread" style={{ marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>New webhook connection</h3>
              <button className="btn sm" onClick={() => setNewHook(null)}>dismiss</button>
            </div>
            <ShowOnce value={newHook.secret} kind="webhook" />
            <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
              inboundUrl (copy this into the provider dashboard):{" "}
              <code className="mono" style={{ wordBreak: "break-all" }}>
                {(webhooks ?? []).find((w) => w.id === newHook.id)?.inboundUrl ?? "loading…"}
              </code>
            </div>
          </div>
        ) : null}

        {webhooks == null ? (
          <div className="empty">loading…</div>
        ) : webhooks.length === 0 ? (
          <div className="empty">no webhook connections yet</div>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Label</th>
                <th>Client</th>
                <th>Platform</th>
                <th>inboundUrl</th>
                <th>Created</th>
                <th>Last received</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {webhooks.map((w) => (
                <tr key={w.id}>
                  <td>{w.label}</td>
                  <td><ClientName id={w.clientId} clients={clients} /></td>
                  <td><span className="badge accent">{w.platform}</span></td>
                  <td>
                    <code className="mono" style={{ fontSize: 10, wordBreak: "break-all" }}>{w.inboundUrl}</code>
                  </td>
                  <td className="faint" style={{ fontSize: 12 }}>{fmtTs(w.createdAt)}</td>
                  <td className="faint" style={{ fontSize: 12 }}>{fmtTs(w.lastReceivedAt)}</td>
                  <td>
                    {w.active ? <span className="badge good">active</span> : <span className="badge bad">revoked</span>}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button className="btn sm" style={{ marginRight: 6 }} onClick={() => openLogs(w.id)}>
                      {openLog === w.id ? "hide logs" : "logs"}
                    </button>
                    {w.active ? (
                      <button className="btn danger sm" onClick={() => revokeHook(w.id)}>revoke</button>
                    ) : (
                      <span className="faint" style={{ fontSize: 11 }}>revoked</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Per-row connection-log drawer (payload-hash only). */}
        {openLog && logsFor[openLog] ? (
          <div className="card" style={{ background: "var(--panel-2)", marginTop: 12 }}>
            <div className="row spread" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Connection log (last {logsFor[openLog].length} · payload-hash only)</h3>
              <button className="btn sm" onClick={() => setOpenLog(null)}>close</button>
            </div>
            {logsFor[openLog].length === 0 ? (
              <div className="empty">no received events yet</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Received</th>
                    <th>Status</th>
                    <th>Payload SHA-256</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {logsFor[openLog].map((l) => (
                    <tr key={l.id}>
                      <td className="faint" style={{ fontSize: 12 }}>{fmtTs(l.receivedAt)}</td>
                      <td>
                        <span className={`badge ${l.status === "ok" ? "good" : l.status === "duplicate" ? "warn" : "bad"}`}>
                          {l.status}
                        </span>
                      </td>
                      <td className="mono" style={{ fontSize: 10, wordBreak: "break-all" }}>{l.payloadHash}</td>
                      <td className="faint" style={{ fontSize: 11, wordBreak: "break-word" }}>{l.error ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>

      {/* --------------------- FLEXIFUNNELS QUICK ACTION ------------------- */}
      <div className="card">
        <div className="row spread" style={{ marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>FlexiFunnels quick-action</h3>
          <span className="faint" style={{ fontSize: 11 }}>UI-only guidance · no provider-side config driven</span>
        </div>

        {ffHooks.length === 0 ? (
          <div className="empty">
            no FlexiFunnels connections yet — generate one above (platform = FlexiFunnels) to get its
            inboundUrl + secret to paste here.
          </div>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            {ffHooks.map((w) => (
              <div key={w.id} className="card" style={{ background: "var(--panel-2)" }}>
                <div className="row spread" style={{ marginBottom: 6 }}>
                  <span className="badge accent">{w.label}</span>
                  <span className={w.active ? "good" : "bad"} style={{ fontSize: 11 }}>{w.active ? "active" : "revoked"}</span>
                </div>
                <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
                  <code className="mono" style={{ wordBreak: "break-all" }}>{w.inboundUrl}</code>
                </div>
                <table className="tbl">
                  <thead>
                    <tr><th>Paste target</th><th>Field</th><th>What to paste</th></tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Form Settings → Webhooks</td>
                      <td className="faint">(leads)</td>
                      <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>inboundUrl + x-webhook-secret</td>
                    </tr>
                    <tr>
                      <td>Products → Product Rules → Webhook</td>
                      <td className="faint">(purchases)</td>
                      <td className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>inboundUrl + x-webhook-secret</td>
                    </tr>
                  </tbody>
                </table>
                <div className="warn" style={{ fontSize: 11, marginTop: 8 }}>
                  The secret is only in the create response (shown once, above). To surface it here
                  again for this connection, generate a fresh FlexiFunnels connection and copy it then.
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
