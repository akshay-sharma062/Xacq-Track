import { Topbar } from "../components/Topbar";
import { ImportForm } from "./ImportForm";

/**
 * Screen 10 — Google Sheets / CSV import (spec 6: "upload with column
 * mapping"). Paste a CSV, map the columns to phone/email/amount/status, and
 * the rows flow through the same ingest pipeline as a live webhook — so old
 * leads + sales backfill onto the right lead, dedup, and source-unknown
 * payments still count in revenue.
 */
export const dynamic = "force-dynamic";

export default function ImportPage() {
  return (
    <>
      <Topbar title="CSV / Sheets import" crumb="Backfill old leads and sales" />
      <ImportForm />
    </>
  );
}
