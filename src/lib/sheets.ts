/**
 * D-16 — Google Sheets lead-sync: server-side fetch of a PUBLIC sheet's CSV export.
 *
 * Mechanism (the key design point): a Google Sheet shared "Anyone with the
 * link can view" exports CSV at a STABLE PUBLIC URL — no credentials:
 *   https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<TAB_GID>
 * (SHEET_ID = the /d/<id> part of the PO's link; gid = the specific tab, 0
 * for the first tab; a tab's gid is the ?gid= / #gid= value in its URL).
 *
 * The fetch is SERVER-SIDE: a browser fetch of a cross-origin Google sheet is
 * CORS-restricted, and this belongs in the server layer anyway. `fetch` is
 * injectable so the lib is unit-testable without the network (vi.stubGlobal).
 *
 * NO CREDENTIALS — private sheets are BLOCKED, never faked:
 *   - the export URL returns 401/403/404 (the sheet is not link-public) →
 *     the caller gets `ok:false` + the EXACT upstream status + a note naming
 *     the two ways forward (make it link-public, OR the Google API path
 *     which needs Google OAuth / service-account credentials in .env — a
 *     SEPARATE, heavier ticket; recorded, not built here).
 *   - a 200 that is HTML instead of CSV (a login page) is ALSO blocked —
 *     we never parse HTML as leads. Empty sheet → rowCount 0 (0, not rows).
 *
 * The committed CSV flows through the EXISTING pipeline
 * (POST /api/import → parseCsv → processInbound platform "sheets"), so
 * dedup/identity/revenue semantics are unchanged and re-syncs are
 * idempotent (gateway txn `import_row_<i>` + phone/email match, spec 6).
 */
import { splitCsv } from "./csv";

/** What the PO pasted: a Google Sheets link (+ optional explicit tab gid). */
export interface SheetTarget {
  /** The /d/<id> sheet id. */
  sheetId: string;
  /** The tab's gid (the ?gid= / #gid= value; "0" = the first tab). */
  tabGid: string;
  /** The stable public export URL (no credentials). */
  exportUrl: string;
  /** Which link shape produced it (the /pub form uses output=csv). */
  kind: "export" | "pub";
}

/**
 * Parse a PO-pasted Google Sheets link into its export target. Accepts the
 * shapes a real link takes:
 *   - …/spreadsheets/d/<ID>/edit            (+ #gid=N, ?gid=N, or /d/<ID>/<GID>)
 *   - …/spreadsheets/d/e/<PUB_KEY>/pub      (publish-to-web; exports via /pub)
 * Returns null when the input is not a recognisable docs.google.com Sheets
 * link — the caller 400s ("not a Google Sheets link"), it never guesses.
 */
export function parseSheetLink(link: string, tabOverride?: string | null): SheetTarget | null {
  const raw = String(link ?? "").trim();
  if (!raw) return null;
  const m =
    // /d/e/<pub-key> form (published-to-web sheets)
    raw.match(/^https?:\/\/(?:www\.)?docs\.google\.[^/]+\/spreadsheets\/d\/e\/([A-Za-z0-9_\-]+)/i) ??
    // /d/<id> form (the PO's normal edit link)
    raw.match(/^https?:\/\/(?:www\.)?docs\.google\.[^/]+\/spreadsheets\/d\/([A-Za-z0-9_\-]+)/i);
  if (!m) return null;

  // The publish-to-web form has its OWN export shape (no /export query).
  if (m[1] && /^https?:\/\/(?:www\.)?docs\.google\.[^/]+\/spreadsheets\/d\/e\//i.test(raw)) {
    const pubKey = m[1];
    return {
      sheetId: pubKey,
      tabGid: "0", // /d/e/ links address one published tab; there is no multi-tab gid
      exportUrl: `https://docs.google.com/spreadsheets/d/e/${pubKey}/pub?output=csv`,
      kind: "pub",
    };
  }

  const sheetId = m[1]!;
  // Tab gid, highest-priority first: the explicit override (the UI's
  // optional "tab" field) > a /d/<id>/<gid> path segment > ?gid= > #gid=.
  const pathGid = raw.match(new RegExp(`/spreadsheets/d/${encodeURIComponent(sheetId)}/([0-9]+)`))?.[1] ?? null;
  const queryGid = raw.match(/[?&]gid=([0-9]+)/i)?.[1] ?? null;
  const fragGid = raw.match(/#?gid=([0-9]+)/i)?.[1] ?? null;
  const tabGid = tabOverride?.trim() || pathGid || queryGid || fragGid || "0";

  return {
    sheetId,
    tabGid,
    // The standard public-export URL (NO credentials — the "link-public" case).
    exportUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${tabGid}`,
    kind: "export",
  };
}

// ---------------------------------------------------------------------------
// The server-side fetch (the seam tests stub).
// ---------------------------------------------------------------------------

export interface SheetCsv {
  /** The CSV text (BOM-stripped; what POST /api/import's parseCsv consumes). */
  csv: string;
  /** Header names (first row; [] when the sheet is empty). */
  columns: string[];
  /** DATA-row count (header excluded; 0 when the sheet has no data rows). */
  rowCount: number;
  /** The public export URL that produced it. */
  exportUrl: string;
  httpStatus: number;
}

export type SheetFetchResult =
  | ({ ok: true } & SheetCsv)
  | { ok: false; httpStatus: number; note: string; exportUrl: string };

const PRIVATE_SHEET_NOTE = (status: number) =>
  `BLOCKED: this Google Sheet is not link-public (Google returned HTTP ${status}). ` +
  `Share it as “Anyone with the link can view” and re-fetch — OR use the ` +
  `Google API path, which needs Google OAuth / service-account credentials in .env ` +
  `(a separate, heavier ticket; recorded, not built here).`;

/**
 * Fetch a public sheet's CSV export on the SERVER (no browser, no
 * credentials). `fetchImpl` is injectable for tests. Caps the body so a
 * pathological "sheet" can't OOM the route.
 */
export async function fetchSheetCsv(
  target: SheetTarget,
  fetchImpl: typeof fetch = fetch,
  maxBytes = 5_000_000
): Promise<SheetFetchResult> {
  let res: Response;
  try {
    res = await fetchImpl(target.exportUrl, { signal: AbortSignal.timeout(20_000) });
  } catch {
    // A timeout / network error is NOT "private" — never invent a status.
    return { ok: false, httpStatus: 0, note: `BLOCKED: could not reach ${target.exportUrl} (network/timeout). Try again.`, exportUrl: target.exportUrl };
  }

  // The ticket's exact contract: a NOT link-public sheet surfaces as 401/403/404.
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { ok: false, httpStatus: res.status, note: PRIVATE_SHEET_NOTE(res.status), exportUrl: target.exportUrl };
  }
  if (!res.ok) {
    // A 5xx/redirect loop is an upstream problem — report it exactly, don't fake CSV.
    return { ok: false, httpStatus: res.status, note: `BLOCKED: Google export failed with HTTP ${res.status}. Wait a moment and re-fetch.`, exportUrl: target.exportUrl };
  }

  const text = await res.text();
  if (text.length > maxBytes) {
    return { ok: false, httpStatus: res.status, note: `BLOCKED: the sheet export is over ${Math.round(maxBytes / 1024 / 1024)} MB — trim it and re-fetch.`, exportUrl: target.exportUrl };
  }

  // A 200 whose body is a login / HTML page (the sheet is not ACTUALLY
  // link-public, or a Google consent wall) is NOT CSV — blocking here is
  // what keeps the "never invent a lead" rule honest (no HTML → no rows).
  const head = text.slice(0, 200).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html") || head.includes("<title")) {
    return { ok: false, httpStatus: res.status, note: PRIVATE_SHEET_NOTE(res.status), exportUrl: target.exportUrl };
  }

  const csv = text.replace(/^﻿/, ""); // Google's CSV export is BOM-prefixed
  const rows = splitCsv(csv);
  const columns = rows.length ? rows[0]! : [];
  const rowCount = Math.max(0, rows.length - 1);
  return { ok: true, csv, columns, rowCount, exportUrl: target.exportUrl, httpStatus: res.status };
}

// ---------------------------------------------------------------------------
// Column-mapping auto-suggest (spec 6 "upload with column mapping").
// Pure + client-importable (no node: deps): the import screen's Google-Sheet
// tab pre-fills the mapping selects from the fetched headers.
// ---------------------------------------------------------------------------

/** Per-field header keywords, checked in order (first hit wins). */
const FIELD_KEYWORDS: Record<string, string[]> = {
  phone: ["phone", "mobile", "whatsapp", "contact no", "contact number"],
  email: ["email", "mail"],
  name: ["name"],
  city: ["city", "location", "town", "state"],
  amount: ["amount", "price", "payment", "total", "value", "fee"],
  status: ["status", "txn", "payment"],
  product: ["product", "item", "plan", "package", "course"],
};

/**
 * Suggest which fetched header maps to each import field. A header matches a
 * field when it contains one of that field's keywords; the mapping is
 * best-effort (the PO always confirms in the selects before commit) and
 * NEVER invents a field — an unmatched field stays "".
 */
export function suggestColumns(headers: string[]): Record<string, string> {
  const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ").trim();
  const out: Record<string, string> = {};
  for (const [field, kws] of Object.entries(FIELD_KEYWORDS)) {
    let hit = "";
    for (const kw of kws) {
      hit = headers.find((h) => norm(h).includes(kw)) ?? "";
      if (hit) break;
    }
    out[field] = hit;
  }
  return out;
}
