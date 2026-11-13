/**
 * D-16 — Google Sheets lead-sync (spec 6 / G7: "upload with column mapping +
 * commit-after-approve"). The public-sheet path, server-side, no credentials:
 *
 *   1. parseSheetLink: a PO-pasted Google Sheets link → the stable public
 *      export URL (…/export?format=csv&gid=<N>); the tab gid from the link's
 *      own /d/<id>/<gid>, ?gid= or #gid= (an explicit override wins);
 *      non-Sheets links → null (the route 400s, never guesses).
 *   2. fetchSheetCsv (fetch stubbed, the onboard.test.ts convention):
 *      - a 200 CSV export → { csv, columns, rowCount } (BOM-stripped);
 *      - an EMPTY sheet → rowCount 0 (0, not rows — never invent a lead);
 *      - a PRIVATE sheet (401/403/404) → BLOCKED with the EXACT upstream
 *        status + the note (share link-public, OR the Google-API path —
 *        recorded, not built), no csv;
 *      - a 200 that is HTML (a login wall) → BLOCKED too (never parse HTML).
 *   3. Idempotent re-sync: fetch → commit → fetch → commit = 0 NEW leads.
 *      The commit is the EXISTING pipeline (processInbound platform "sheets",
 *      exactly what POST /api/import runs): the lead dedups by phone/email
 *      (spec 4) and the payment dedups on the gateway txn
 *      `import_row_<i>` (spec 6).
 *   4. Column mapping reaches the RIGHT fields: the sheets adapter maps the
 *      caller-provided header names onto phone/email/name/amount/status.
 *   5. Route wiring (source contract): /api/import/sheets relays the exact
 *      upstream status on BLOCKED, 400s a non-Sheet link, and never writes
 *      leads itself (the commit stays POST /api/import).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import { processInbound } from "../src/lib/ingest";
import { parseSheetLink, fetchSheetCsv, suggestColumns } from "../src/lib/sheets";

const FIT = "cl_upcurvv"; // the tenancy bootstrap client

const SHEET_CSV = [
  "Phone,Email,Name,Amount,Status,Product",
  "9812340001,lead1@x.com,Asha,24999,Paid,FML",
  "9812340002,lead2@x.com,Ravi,49999,Refunded,FML",
].join("\n");

function sheet200(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/csv" } });
}
function sheetStatus(status: number, body = "Forbidden"): Response {
  return new Response(body, { status });
}

const ROUTE_SHEETS = readFileSync("src/app/api/import/sheets/route.ts", "utf8");
const IMPORT_ROUTE = readFileSync("src/app/api/import/route.ts", "utf8");

// ---------------------------------------------------------------------------
// 1 — parseSheetLink: link → stable public export URL (no credentials).
// ---------------------------------------------------------------------------

describe("D-16 parseSheetLink — the PO's link resolves to the public CSV export URL", () => {
  it("an /edit link with no tab info exports the FIRST tab (gid=0)", () => {
    const t = parseSheetLink("https://docs.google.com/spreadsheets/d/abcDEF123/edit#gid=17");
    expect(t).not.toBeNull();
    expect(t!.sheetId).toBe("abcDEF123");
    expect(t!.tabGid).toBe("17");
    expect(t!.exportUrl).toBe("https://docs.google.com/spreadsheets/d/abcDEF123/export?format=csv&gid=17");
    expect(t!.kind).toBe("export");
  });

  it("a bare /d/<id> link defaults to gid=0 (the first tab)", () => {
    const t = parseSheetLink("https://docs.google.com/spreadsheets/d/Sheet9/edit");
    expect(t!.tabGid).toBe("0");
    expect(t!.exportUrl).toBe("https://docs.google.com/spreadsheets/d/Sheet9/export?format=csv&gid=0");
  });

  it("a path-segment tab (/d/<id>/<GID>) wins, then ?gid= / #gid=, then an explicit override wins over all", () => {
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/S1/1234")!.tabGid).toBe("1234");
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/S2/edit?gid=55&x=1")!.tabGid).toBe("55");
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/S3/edit#gid=66")!.tabGid).toBe("66");
    // The UI's optional "tab" field is the highest-priority source:
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/S4/edit?gid=77", "88")!.tabGid).toBe("88");
    expect(parseSheetLink("https://docs.google.com/spreadsheets/d/S4/edit", "88")!.tabGid).toBe("88");
  });

  it("a publish-to-web link (/d/e/<key>/pub) resolves to its OWN export shape", () => {
    const t = parseSheetLink("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub");
    expect(t!.kind).toBe("pub");
    expect(t!.exportUrl).toBe("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv");
  });

  it("a non-Google-Sheets link is null (the route 400s — never a guessed fetch)", () => {
    expect(parseSheetLink("https://example.com/sheets/x")).toBeNull();
    expect(parseSheetLink("not a url")).toBeNull();
    expect(parseSheetLink("")).toBeNull();
    expect(parseSheetLink("https://drive.google.com/file/d/x/view")).toBeNull(); // a Drive FILE, not a Sheet
  });
});

// ---------------------------------------------------------------------------
// 2 — fetchSheetCsv: the exact-status BLOCKED contract + empty-sheet = 0.
// ---------------------------------------------------------------------------

describe("D-16 fetchSheetCsv — public CSV in, private/HTML/empty BLOCKED (no fake rows)", () => {
  const TARGET = parseSheetLink("https://docs.google.com/spreadsheets/d/SheetX/edit")!;

  it("a 200 CSV export returns the BOM-stripped csv + columns + data-row count", async () => {
    const r = await fetchSheetCsv(TARGET, () => Promise.resolve(sheet200("﻿" + SHEET_CSV)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.httpStatus).toBe(200);
    expect(r.csv).toBe(SHEET_CSV); // the BOM is gone
    expect(r.columns).toEqual(["Phone", "Email", "Name", "Amount", "Status", "Product"]);
    expect(r.rowCount).toBe(2); // data rows, header excluded
  });

  it("an EMPTY sheet → ok with rowCount 0 (the commit of nothing is safe; never a placeholder row)", async () => {
    const r = await fetchSheetCsv(TARGET, () => Promise.resolve(sheet200("")));
    expect(r).toMatchObject({ ok: true, columns: [], rowCount: 0 });
    // Header-only sheet (no data rows) is 0 too:
    const h = await fetchSheetCsv(TARGET, () => Promise.resolve(sheet200("Phone,Email,Name")));
    expect(h).toMatchObject({ ok: true, rowCount: 0 });
    if (h.ok) expect(h.columns).toEqual(["Phone", "Email", "Name"]);
  });

  it.each([401, 403, 404])("a PRIVATE sheet (HTTP %i) → BLOCKED with the EXACT status, no csv", async (status) => {
    const r = await fetchSheetCsv(TARGET, () => Promise.resolve(sheetStatus(status)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.httpStatus).toBe(status); // the exact upstream status, never invented
    expect(r.note).toMatch(/not link-public/i);
    expect(r.note).toMatch(new RegExp(`HTTP ${status}`)); // the EXACT status
    expect(r.note).toMatch(/Google API path/i); // the credentials path is named
    expect(r.note).toMatch(/service-account credentials in .env/i);
  });

  it("a 200 whose body is HTML (a login/consent wall) → BLOCKED, never parsed as CSV", async () => {
    const r = await fetchSheetCsv(TARGET, () =>
      Promise.resolve(new Response("<!doctype html><html><head><title>Sign in</title></head></html>", { status: 200, headers: { "Content-Type": "text/html" } }))
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.httpStatus).toBe(200);
    expect(r.note).toMatch(/not link-public/i);
    expect(r.note).toMatch(/Google API path/i);
  });

  it("a 5xx is relayed exactly (upstream problem, not 'private', not CSV)", async () => {
    const r = await fetchSheetCsv(TARGET, () => Promise.resolve(sheetStatus(503, "unavailable")));
    expect(r).toMatchObject({ ok: false, httpStatus: 503 });
    if (!r.ok) expect(r.note).toMatch(/HTTP 503/);
  });

  it("a network/timeout failure is its own BLOCKED (httpStatus 0 — never a fake status)", async () => {
    const r = await fetchSheetCsv(TARGET, () => Promise.reject(new Error("timeout")));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(0);
      expect(r.note).toMatch(/network|timeout/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3 — Idempotent re-sync: commit → commit = 0 NEW leads (the pipeline).
// ---------------------------------------------------------------------------

describe("D-16 re-sync idempotency — the commit is the existing pipeline (dedup holds)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  /** Exactly what POST /api/import builds from the fetched sheet. */
  function sheetsRawBody(columns: Record<string, string>, rows: Record<string, string>[]) {
    return JSON.stringify({ platform: "sheets", columns, rows });
  }

  const COLS = { phone: "Phone", email: "Email", name: "Name", amount: "Amount", status: "Status", product: "Product" };
  const ROWS = [
    { Phone: "9812340001", Email: "lead1@x.com", Name: "Asha", Amount: "24999", Status: "Paid", Product: "FML" },
    { Phone: "9812340002", Email: "lead2@x.com", Name: "Ravi", Amount: "49999", Status: "Refunded", Product: "FML" },
  ];

  it("fetch → commit → fetch → commit: the lead count is a FIXED POINT (0 new on re-sync)", async () => {
    const p: PrismaClient = db.prisma;
    // Sync 1: the sheet's 2 rows create 2 leads + 2 payments.
    const r1 = await processInbound({ prisma: p, clientId: FIT, platform: "sheets", clientSecret: null, rawBody: sheetsRawBody(COLS, ROWS), headers: {} });
    expect(r1.status).toBe("processed");
    expect(r1.leadIds).toHaveLength(2);
    const leadsAfter1 = await p.lead.count({ where: { clientId: FIT } });
    const paysAfter1 = await p.payment.count({ where: { clientId: FIT } });
    expect(leadsAfter1).toBe(2);
    expect(paysAfter1).toBe(2);

    // Sync 2: the SAME sheet, re-fetched, re-committed (the D-16 re-sync):
    const r2 = await processInbound({ prisma: p, clientId: FIT, platform: "sheets", clientSecret: null, rawBody: sheetsRawBody(COLS, ROWS), headers: {} });
    expect(r2.leadIds).toHaveLength(2); // the same (existing) leads, by phone match
    const leadsAfter2 = await p.lead.count({ where: { clientId: FIT } });
    const paysAfter2 = await p.payment.count({ where: { clientId: FIT } });
    expect(leadsAfter2).toBe(leadsAfter1); // 0 NEW leads
    expect(paysAfter2).toBe(paysAfter1); // 0 NEW payments (the txn dedup held)
    // The payments deduped on the gateway txn (import_row_0 / _1):
    const txns = await p.payment.findMany({ where: { clientId: FIT }, select: { gatewayTxnId: true } });
    expect(new Set(txns.map((t) => t.gatewayTxnId)).size).toBe(txns.length);
  });

  it("a PAID row creates a revenue lead + queued Purchase CAPI (the money path the [REVIEW] gate covers)", async () => {
    const p: PrismaClient = db.prisma;
    await processInbound({ prisma: p, clientId: FIT, platform: "sheets", clientSecret: null, rawBody: sheetsRawBody(COLS, [ROWS[0]!]), headers: {} });
    const lead = await p.lead.findFirst({ where: { clientId: FIT, phoneNormalized: "+919812340001" } });
    expect(lead).not.toBeNull();
    expect(lead!.stage).toBe("Paid"); // the auto stage move (spec 5.5)
    const capi = await p.outboundEvent.findFirst({ where: { leadId: lead!.id, type: "Purchase" } });
    expect(capi).not.toBeNull(); // the committed payment queued a CAPI Purchase
  });
});

// ---------------------------------------------------------------------------
// 4 — Column mapping reaches the RIGHT fields (the adapter, not the UI).
// ---------------------------------------------------------------------------

describe("D-16 column mapping — a mapped sheet row lands on the right lead fields", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("unusual header names map via the caller-provided columns (the mapping, not the header text)", async () => {
    const p: PrismaClient = db.prisma;
    // The PO's sheet uses its own header names; the mapping says which is which.
    await processInbound({
      prisma: p, clientId: FIT, platform: "sheets", clientSecret: null,
      rawBody: JSON.stringify({
        platform: "sheets",
        columns: { phone: "Mob", email: "Mail", name: "FullName", amount: "Rs", status: "Paid?", product: "Plan" },
        rows: [{ Mob: "9812340077", Mail: "mapped@x.com", FullName: "Mapped", Rs: "12345", "Paid?": "Paid", Plan: "Pro" }],
      }),
      headers: {},
    });
    const lead = await p.lead.findFirst({ where: { clientId: FIT, phoneNormalized: "+919812340077" } });
    expect(lead).not.toBeNull();
    expect(lead!.email).toBe("mapped@x.com"); // the email column landed on email
    expect(lead!.name).toBe("Mapped");
    const pay = await p.payment.findFirst({ where: { clientId: FIT } });
    expect(pay).not.toBeNull();
    expect(pay!.amount).toBe(12345); // the amount column landed on amount
    expect(pay!.product).toBe("Pro");
  });

  it("an UNMAPPED status column means the row is a plain form_submit (no payment row invented)", async () => {
    const p: PrismaClient = db.prisma;
    await processInbound({
      prisma: p, clientId: FIT, platform: "sheets", clientSecret: null,
      rawBody: JSON.stringify({
        platform: "sheets",
        columns: { phone: "Phone", name: "Name" }, // NO status/amount → not a payment
        rows: [{ Phone: "9812340099", Name: "NoPay" }],
      }),
      headers: {},
    });
    expect(await p.lead.count({ where: { clientId: FIT } })).toBe(1);
    expect(await p.payment.count({ where: { clientId: FIT } })).toBe(0); // no payment invented
  });
});

// ---------------------------------------------------------------------------
// suggestColumns: the auto-mapping the preview pre-fills (best-effort, never
// invents — an unmatched field stays "").
// ---------------------------------------------------------------------------

describe("D-16 suggestColumns — the fetched headers pre-fill the mapping", () => {
  it("maps the common headers onto the right fields", () => {
    const s = suggestColumns(["Phone Number", "Email", "Full Name", "City", "Amount", "Payment Status"]);
    expect(s.phone).toBe("Phone Number");
    expect(s.email).toBe("Email");
    expect(s.name).toBe("Full Name");
    expect(s.city).toBe("City");
    expect(s.amount).toBe("Amount");
    expect(s.status).toBe("Payment Status");
  });

  it("never invents a field: an unmatched field stays empty", () => {
    const s = suggestColumns(["A", "B"]);
    expect(s.phone).toBe("");
    expect(s.email).toBe("");
    expect(s.amount).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 5 — Route wiring (source contract, the D-13/D-15 precedent): the sheets
// route READS the sheet (never writes leads); the commit stays POST /api/import.
// ---------------------------------------------------------------------------

describe("D-16 route wiring — fetch route is read-only; the exact-status BLOCKED is relayed", () => {
  it("/api/import/sheets: 401 unauth, a non-Sheet link is a 400 (never a guessed fetch), BLOCKED relays the EXACT upstream status", () => {
    expect(ROUTE_SHEETS).toMatch(/getSession\(\)/);
    expect(ROUTE_SHEETS).toMatch(/status: 401/);
    expect(ROUTE_SHEETS).toMatch(/not a Google Sheets link/);
    expect(ROUTE_SHEETS).toMatch(/status: 400/);
    // The BLOCKED response carries the exact upstream status + the note:
    expect(ROUTE_SHEETS).toMatch(/upstreamStatus: res\.httpStatus/);
    expect(ROUTE_SHEETS).toMatch(/note: res\.note/);
    // READ-ONLY: the route never writes a lead (the commit is the existing pipeline).
    expect(ROUTE_SHEETS).not.toMatch(/prisma\./);
    expect(ROUTE_SHEETS).not.toMatch(/processInbound/);
  });

  it("POST /api/import is still the commit step (csv + columns → the sheets pipeline)", () => {
    expect(IMPORT_ROUTE).toMatch(/parseCsv\(csv\)/);
    expect(IMPORT_ROUTE).toMatch(/platform: "sheets"/);
    expect(IMPORT_ROUTE).toMatch(/processInbound\(/);
  });

  it("an injected fetch (the seam) keeps the lib testable without the network", () => {
    const lib = readFileSync("src/lib/sheets.ts", "utf8");
    expect(lib).toMatch(/fetchImpl: typeof fetch = fetch/);
    // The private-sheet note names BOTH ways forward (the ticket's contract):
    expect(lib).toMatch(/Anyone with the link/i);
    expect(lib).toMatch(/Google API path/i);
    expect(lib).toMatch(/credentials in .env/i);
  });
});
