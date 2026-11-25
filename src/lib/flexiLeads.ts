/**
 * "Flexi Leads" report — a receipt-level view of every FlexiFunnels webhook
 * receipt: the full raw payload (identity + every UTM value + custom form
 * answers + fbclid + page context), the ingested lead it created, and the
 * Meta ad account it resolves to. Read-only over data already on disk
 * (spec 4: `WebhookLog.rawPayload` = the exact raw body; `Event.rawPayload.meta`
 * = the record-level custom fields, D-19; `Lead`/`Touchpoint` = the ingested
 * identity + attribution). This module only reads + shapes — it writes nothing.
 *
 * D-23 — this is now a THIN WRAPPER over the shared, platform-agnostic
 * `platformLeadsReport(platform: "flexifunnels", …)` (src/lib/platformLeads.ts),
 * so the Lovable + TagMango tabs reuse the SAME builder + screen instead of
 * copy-pasting this 3×. The FlexiFunnels field spec (the FLAT shape, reusing
 * the D-19 `flexiFormFieldsFromRaw` extractor) lives in platformLeads.ts; the
 * ad-account attribution + filter + KPI + table are shared + platform-
 * independent. The public `flexiLeadsReport` + its types are preserved so
 * `/flexi-leads` renders EXACTLY as before (no regression).
 *
 * Ad-account attribution (the chosen contract, shared): FlexiFunnels payloads
 * carry UTM + fbclid, NOT Meta ad ids — but `utm_id` / `utm_term` ARE Meta
 * ad-set / ad ids. So a receipt resolves to an ad account by:
 *   1. "utm" — the receipt's `utm_term` / `utm_id` matches a pulled
 *      AdSet / Ad / AdCampaign under the client's accounts;
 *   2. "meta_touchpoint" — otherwise the receipt's lead has a Meta ad-click
 *      touchpoint (`adRefId` → `Ad` → `AdAccount`);
 *   3. "unmatched" — neither (organic / unknown). Never guessed.
 * When an ad-account filter is set, unmatched receipts are excluded from the
 * table (they are not under that account) but counted so the KPI stays honest.
 */
import { PrismaClient } from "@prisma/client";
import {
  platformLeadsReport,
  PlatformLeadRow,
  PlatformLeadsReport,
} from "./platformLeads";
import { Session } from "./session";

// Preserved public types (the /flexi-leads screen + the flexiLeads tests import
// these). They are the shared, generalized shapes — a superset is fine.
export type FlexiEventKind = PlatformLeadRow["eventKind"];
export type FlexiAttribution = PlatformLeadRow["attribution"];
export type FlexiLeadRow = PlatformLeadRow;
export type FlexiLeadsReport = PlatformLeadsReport;

export interface FlexiLeadsOptions {
  clientIds: string[]; // the session's visible set (or the ?client= single)
  adAccountId?: string; // internal AdAccount.id (when ?adAccount= is set)
  session: Session; // for phone masking (spec 5.10)
  limit?: number; // max receipts, default 200
}

/** The pre-D-23 public entry point — now a thin wrapper over the shared
 *  platform builder with the FlexiFunnels field spec. */
export function flexiLeadsReport(
  prisma: PrismaClient,
  opts: FlexiLeadsOptions,
): Promise<FlexiLeadsReport> {
  return platformLeadsReport(prisma, { ...opts, platform: "flexifunnels" });
}
