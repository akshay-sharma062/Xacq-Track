"use client";

import { useEffect, useState } from "react";

/**
 * Loads the active client's settings (GET /api/settings) and saves changes
 * (PATCH /api/settings). Attribution model + window default to last-paid-click
 * 30d (spec 7); the webhook secret is per-client (spec 5.6).
 */
export function SettingsForm() {
  const clientId =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("client") : null;

  const [model, setModel] = useState("last_paid_click");
  const [windowDays, setWindowDays] = useState(30);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [metaPixelId, setMetaPixelId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(clientId ? { client: clientId } : {});
    fetch(`/api/settings?${params.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) {
          setMsg(j.error);
          return;
        }
        setModel(j.attributionModel);
        setWindowDays(j.attributionWindowDays);
        setWebhookSecret(j.webhookSecret ?? "");
        setMetaPixelId(j.metaPixelId ?? "");
        setLoaded(true);
      })
      .catch((e) => setMsg(String(e)));
  }, [clientId]);

  async function save() {
    setMsg(null);
    const params = new URLSearchParams(clientId ? { client: clientId } : {});
    const r = await fetch(`/api/settings?${params.toString()}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, windowDays, webhookSecret, metaPixelId }),
    });
    const j = await r.json().catch(() => ({}));
    setMsg(r.ok ? "saved" : j.error ?? `error ${r.status}`);
  }

  return (
    <div className="card">
      <h3>Client settings</h3>
      {!loaded ? <div className="empty">loading…</div> : (
        <div className="stack">
          <div className="grid cols-2">
            <div className="row">
              <span className="muted" style={{ fontSize: 12, width: 110 }}>Attribution model</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} style={{ flex: 1 }}>
                <option value="last_paid_click">last paid click (default)</option>
                <option value="first_click">first click</option>
                <option value="linear">linear</option>
                <option value="lead_source">lead source</option>
              </select>
            </div>
            <div className="row">
              <span className="muted" style={{ fontSize: 12, width: 110 }}>Window (days)</span>
              <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
                <option value={7}>7</option>
                <option value={14}>14</option>
                <option value={30}>30</option>
                <option value={60}>60</option>
              </select>
            </div>
            <div className="row">
              <span className="muted" style={{ fontSize: 12, width: 110 }}>Webhook secret</span>
              <input value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} style={{ flex: 1 }} />
            </div>
            <div className="row">
              <span className="muted" style={{ fontSize: 12, width: 110 }}>CAPI pixel</span>
              <input value={metaPixelId} onChange={(e) => setMetaPixelId(e.target.value)} placeholder="pixel/dataset id" style={{ flex: 1 }} />
            </div>
          </div>
          <div className="row">
            <button className="btn primary" onClick={save}>Save</button>
            {msg ? <span className={msg === "saved" ? "good" : "bad"} style={{ fontSize: 12 }}>{msg}</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
