"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { parseSheetLink, suggestColumns } from "@/lib/sheets";
import { splitCsv } from "@/lib/csv";

/**
 * D-16 — import screen with TWO modes (spec 6: "upload with column mapping
 * + commit-after-approve"):
 *   1. Paste CSV (the original) — a raw CSV + column mapping → POST /api/import.
 *   2. Google Sheet sync (NEW) — the PO pastes the sheet's share link, the
 *      SERVER fetches its public CSV export (GET /api/import/sheets, no
 *      credentials), the screen previews the rows + auto-suggests the column
 *      mapping, and "Commit N leads" runs the SAME pipeline.
 *
 * The Pabbly note: for a page whose only webhook slot is already Pabbly's,
 * the sheet IS the lead-capture path (the PO dumps those leads into a sheet)
 * — for pages with a free slot, the Pabbly webhook (G4/D-06) is the live
 * alternative. This screen is the backfill for the sheet side of that.
 */
export function ImportForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"csv" | "sheets">("csv");

  // ---- Paste-CSV mode (unchanged) ------------------------------------------
  const [csv, setCsv] = useState("");
  const [cols, setCols] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const headers = csv.trim().split("\n")[0]?.split(",").map((h) => h.trim()) ?? [];

  function set(key: string, val: string) {
    setCols((c) => ({ ...c, [key]: val }));
  }

  async function submitCsv() {
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

  // ---- Google-Sheet sync mode (D-16) ---------------------------------------
  const [clientOpts, setClientOpts] = useState<{ id: string; name: string }[]>([]);
  const [sheetClient, setSheetClient] = useState("");
  const [sheetUrl, setSheetUrl] = useState("");
  const [sheetTab, setSheetTab] = useState("");
  const [fetching, setFetching] = useState(false);
  const [committing, setCommitting] = useState(false);

  // The fetched sheet: csv (what the commit POSTs back) + preview + mapping.
  const [sheetCsv, setSheetCsv] = useState("");
  const [sheetCols, setSheetCols] = useState<Record<string, string>>({});
  const [previewRows, setPreviewRows] = useState<string[][]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [sheetResult, setSheetResult] = useState<string | null>(null);

  useEffect(() => {
    // Client dropdown = the session's visible clients (the owner/admin sees
    // the workspace set; the ?client= query param pre-selects one).
    fetch("/api/session")
      .then((r) => r.json())
      .then((j) => {
        const list: { id: string; name: string }[] = Array.isArray(j.clients) ? j.clients : [];
        setClientOpts(list);
        const pre = new URLSearchParams(window.location.search).get("client") ?? list[0]?.id ?? "";
        setSheetClient(pre);
      })
      .catch(() => {});
  }, []);

  const target = parseSheetLink(sheetUrl, sheetTab || null);

  async function fetchSheet() {
    setFetching(true);
    setBlocked(null);
    setSheetResult(null);
    setSheetCsv("");
    setPreviewRows([]);
    setRowCount(0);
    const qs = new URLSearchParams({ url: sheetUrl.trim() });
    if (sheetClient) qs.set("client", sheetClient);
    if (target && target.tabGid !== "0") qs.set("tab", target.tabGid);
    const r = await fetch(`/api/import/sheets?${qs.toString()}`);
    const j = await r.json().catch(() => ({}));
    setFetching(false);
    if (r.status === 403 && j.blocked) {
      // A private / not-link-public sheet: relay EXACTLY, never fake rows.
      setBlocked(`${j.note} (upstream HTTP ${j.upstreamStatus})`);
      return;
    }
    if (!r.ok) {
      setBlocked(j.error ?? `error ${r.status}`);
      return;
    }
    const text: string = j.csv ?? "";
    setSheetCsv(text);
    setRowCount(j.rowCount ?? 0);
    const rows = splitCsv(text);
    // Preview = the first 8 DATA rows (row 0 is the header, shown in thead).
    setPreviewRows(rows.slice(1, 9));
    // Auto-suggest the mapping from the fetched headers (best-effort; the PO
    // confirms in the selects before commit).
    setSheetCols(suggestColumns(j.columns ?? []));
  }

  async function commitSheet() {
    if (!sheetCsv) return;
    setCommitting(true);
    setSheetResult(null);
    const r = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csv: sheetCsv, columns: sheetCols, clientId: sheetClient || undefined }),
    });
    const j = await r.json().catch(() => ({}));
    setCommitting(false);
    if (r.ok) {
      setSheetResult(`committed ${j.importedRows} rows → ${j.events} events, ${j.payments} payments, ${j.leadIds.length} leads (re-syncs dedup — same sheet again = 0 new)`);
      router.refresh();
    } else {
      setSheetResult(j.error ?? `error ${r.status}`);
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
    <div className="stack" style={{ gap: 14 }}>
      {/* mode tabs */}
      <div className="row" style={{ gap: 8 }}>
        <button className={`btn sm ${mode === "csv" ? "primary" : ""}`} onClick={() => setMode("csv")}>Paste CSV</button>
        <button className={`btn sm ${mode === "sheets" ? "primary" : ""}`} onClick={() => setMode("sheets")}>Google Sheet sync</button>
      </div>

      {mode === "csv" ? (
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
            <button className="btn primary" onClick={submitCsv} disabled={busy || !csv.trim()}>
              {busy ? "Importing…" : "Import"}
            </button>
            {result ? <span className={result.startsWith("imported") ? "good" : "bad"} style={{ fontSize: 12 }}>{result}</span> : null}
          </div>
        </div>
      ) : (
        /* ---- Google Sheet sync (D-16): fetch → preview → map → commit ---- */
        <div className="card">
          <h3>Google Sheet sync</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            For pages whose only webhook slot is already Pabbly’s: the PO dumps those leads into a
            Google Sheet shared as “Anyone with the link can view”. Paste the sheet’s link below —
            the fetch runs SERVER-SIDE (no credentials), the rows flow through the same ingest
            pipeline (dedup by phone/email + gateway txn), so re-syncing the same sheet adds 0
            duplicates.
          </p>

          <div className="grid cols-3 mt">
            <div style={{ gridColumn: "span 2" }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Google Sheet link (share / edit URL)</div>
              <input
                placeholder={"https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit"}
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Tab GID (optional; 0 = first tab)</div>
              <input
                placeholder={target && target.tabGid !== "0" ? target.tabGid : "0"}
                value={sheetTab}
                onChange={(e) => setSheetTab(e.target.value)}
                style={{ width: "100%", fontSize: 12 }}
              />
            </div>
            <div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>Client</div>
              <select value={sheetClient} onChange={(e) => setSheetClient(e.target.value)} style={{ width: "100%" }}>
                {clientOpts.length === 0 ? <option value="">…</option> : null}
                {clientOpts.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="row mt">
            <button className="btn primary" onClick={fetchSheet} disabled={fetching || !sheetUrl.trim() || !sheetClient}>
              {fetching ? "Fetching…" : "Fetch & preview"}
            </button>
            {rowCount > 0 ? (
              <span className="muted" style={{ fontSize: 12 }}>{rowCount} data rows fetched</span>
            ) : null}
          </div>

          {/* BLOCKED (a private / not-link-public sheet): the exact upstream
              status + the note (share link-public, or the Google-API path). */}
          {blocked ? (
            <div className="card mt" style={{ background: "rgba(255,90,90,0.07)", borderColor: "rgba(255,90,90,0.35)" }}>
              <span className="bad" style={{ fontSize: 12 }}>{blocked}</span>
            </div>
          ) : null}

          {/* PREVIEW + MAPPING (only when a public sheet fetched). */}
          {sheetCsv && !blocked ? (
            <div className="mt">
              <div className="muted" style={{ fontSize: 11 }}>Preview (first {previewRows.length} of {rowCount} data rows):</div>
              {previewRows.length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" style={{ fontSize: 11 }}>
                    <thead>
                      <tr>{(splitCsv(sheetCsv)[0] ?? []).map((h, i) => <th key={i}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, ri) => (
                        <tr key={ri}>{(splitCsv(sheetCsv)[0] ?? []).map((_, ci) => <td key={ci}>{row[ci] ?? ""}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>0 data rows — the sheet is empty (nothing committed; a re-sync is safe).</div>
              )}

              <div className="grid cols-4 mt">
                {fields.map((f) => (
                  <div key={f.key} className="row" style={{ gap: 6 }}>
                    <span className="muted" style={{ fontSize: 12, width: 70 }}>{f.label}</span>
                    <select value={sheetCols[f.key] ?? ""} onChange={(e) => setSheetCols((c) => ({ ...c, [f.key]: e.target.value }))} style={{ flex: 1 }}>
                      <option value="">—</option>
                      {(splitCsv(sheetCsv)[0] ?? []).map((h, i) => (
                        <option key={i} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="row mt">
                <button className="btn primary" onClick={commitSheet} disabled={committing || !sheetClient}>
                  {committing ? "Committing…" : `Commit ${rowCount} leads`}
                </button>
                {sheetResult ? <span className={sheetResult.startsWith("committed") ? "good" : "bad"} style={{ fontSize: 12 }}>{sheetResult}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
