/**
 * D-16 — Google Sheets lead-sync: fetch a PUBLIC sheet's CSV export, server-side.
 *
 *   GET /api/import/sheets?client=<id>&url=<sheetLink>[&tab=<gid>]
 *       → 200 { csv, columns, rowCount, exportUrl }   (the sheet IS link-public)
 *       → 403 { blocked, upstreamStatus, note }       (private/HTML — exact status,
 *                                                      the "share link-public /
 *                                                      Google API creds" note)
 *       → 400 "not a Google Sheets link"              (the URL is unparseable)
 *
 * This route READS the sheet — it never writes leads. The commit is the
 * EXISTING POST /api/import (csv + column mapping → the same "sheets" ingest
 * pipeline), so preview and commit are the two-step the ticket's spec §6
 * "commit-after-approve" wants. No credentials are used here: a private
 * sheet's 401/403/404 is relayed EXACTLY (never faked into rows) and the
 * note names the two ways forward.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession, resolveClient } from "@/lib/api-utils";
import { parseSheetLink, fetchSheetCsv } from "@/lib/sheets";

export async function GET(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const url = req.nextUrl.searchParams.get("url") ?? "";
  const tab = req.nextUrl.searchParams.get("tab");
  const clientParam = req.nextUrl.searchParams.get("client") ?? undefined;
  const clientId = await resolveClient(s, clientParam);
  if (!clientId) return NextResponse.json({ error: "no visible client" }, { status: 403 });

  // A non-Google-Sheets link is a 400, not a fetch — never guess an export URL.
  const target = parseSheetLink(url, tab);
  if (!target) {
    return NextResponse.json(
      { error: "not a Google Sheets link — paste the sheet's share/edit URL (docs.google.com/spreadsheets/d/…)" },
      { status: 400 }
    );
  }

  const res = await fetchSheetCsv(target);
  if (!res.ok) {
    // Relay the EXACT upstream status + the note (private → 401/403/404, or
    // a 200-HTML login wall). The UI shows the note; no rows are invented.
    return NextResponse.json(
      { blocked: true, upstreamStatus: res.httpStatus, note: res.note, exportUrl: res.exportUrl },
      { status: 403 }
    );
  }
  return NextResponse.json({
    csv: res.csv,
    columns: res.columns,
    rowCount: res.rowCount,
    exportUrl: res.exportUrl,
    client: clientId,
  });
}
