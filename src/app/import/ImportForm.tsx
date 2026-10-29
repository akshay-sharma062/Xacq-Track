"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Paste a CSV, map its columns to the fields Xacqora Track understands, and
 * submit. Rows that carry a payment status flow through the same pipeline as
 * a live gateway webhook (dedup + source-unknown handling, spec 6).
 */
export function ImportForm() {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [cols, setCols] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // Detect header names from the first line so the user just picks columns.
  const headers = csv.trim().split("\n")[0]?.split(",").map((h) => h.trim()) ?? [];

  function set(key: string, val: string) {
    setCols((c) => ({ ...c, [key]: val }));
  }

  async function submit() {
    setBusy(true);
    setResult(null);
    const clientId = new URLSearchParams(window.location.search).get("client") ?? undefined;
    const r = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv, columns: cols, clientId }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (r.ok) {
      setResult(`imported ${j.importedRows} rows → ${j.events} events, ${j.payments} payments, ${j.leadIds.length} leads`);
      router.refresh();
    } else {
      setResult(j.error ?? `error ${r.status}`);
    }
  }

  const fields: { key: string; label: string }[] = [
    { key: "phone", label: "Phone" },
    { key: "email", label: "Email" },
    { key: "name", label: "Name" },
    { key: "city", label: "City" },
    { key: "amount", label: "Amount" },
    { key: "status", label: "Status (Paid/Refunded/Failed)" },
    { key: "product", label: "Product" },
  ];

  return (
    <div className="card">
      <h3>Paste CSV</h3>
      <textarea
        rows={8}
        placeholder={"Phone,Email,Name,Amount,Status\n9812340001,lead@x.com,Asha,24999,Paid"}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        style={{ width: "100%", fontFamily: "var(--mono, monospace)", fontSize: 12 }}
      />
      {headers.length > 0 ? (
        <div className="grid cols-4 mt">
          {fields.map((f) => (
            <div key={f.key} className="row" style={{ gap: 6 }}>
              <span className="muted" style={{ fontSize: 12, width: 70 }}>{f.label}</span>
              <select value={cols[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} style={{ flex: 1 }}>
                <option value="">—</option>
                {headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ) : null}
      <div className="row mt">
        <button className="btn primary" onClick={submit} disabled={busy || !csv.trim()}>
          {busy ? "Importing…" : "Import"}
        </button>
        {result ? <span className={result.startsWith("imported") ? "good" : "bad"} style={{ fontSize: 12 }}>{result}</span> : null}
      </div>
    </div>
  );
}
