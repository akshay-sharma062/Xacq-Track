/**
 * Google Sheets / CSV import (spec 6: "upload with column mapping").
 *
 *   POST /api/import
 *   body: { client, csv, columns: { phone, email, name, city, amount, status, product } }
 *
 * The CSV is parsed (src/lib/csv), each row mapped by the caller-provided
 * column labels, and run through the SAME ingest pipeline as a live webhook —
 * so old leads + sales backfill onto the right lead, dedup by gateway txn, and
 * a payment with no matching lead becomes a "source unknown" lead that still
 * counts in revenue (spec 6).
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { parseCsv, ColumnMap } from "@/lib/csv";
import { processInbound } from "@/lib/ingest";

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const b = await req.json().catch(() => ({}));
  const clientId = await resolveClient(s, b.clientId);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  const csv: string = typeof b.csv === "string" ? b.csv : "";
  if (!csv.trim()) return NextResponse.json({ error: "csv required" }, { status: 400 });
  const columns: ColumnMap = b.columns ?? {};

  // parseCsv returns rows keyed by the ORIGINAL header names. The sheets
  // adapter (spec 8 saved sample + replay test) expects exactly that: raw
  // source-header rows + a `columns` map telling it which column is
  // phone/email/amount/status. Keep the shape identical to the sample.
  const rows = parseCsv(csv);
  const rawBody = JSON.stringify({
    platform: "sheets",
    columns,
    rows,
  });

  const res = await processInbound({
    prisma,
    clientId,
    platform: "sheets",
    clientSecret: null,
    rawBody,
    headers: {},
  });
  return NextResponse.json({
    importedRows: rows.length,
    status: res.status,
    events: res.events,
    payments: res.payments,
    leadIds: res.leadIds,
  });
}
