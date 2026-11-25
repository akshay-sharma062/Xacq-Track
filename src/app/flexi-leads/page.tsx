import { PlatformLeadsView } from "../components/PlatformLeadsView";
import { qs } from "@/lib/api-utils";

/**
 * Screen — "Flexi Leads": a receipt-level report of every FlexiFunnels webhook.
 * Each row = one `WebhookLog` receipt: the full raw payload (identity + every
 * UTM value + custom form answers + fbclid + page context), the ingested lead
 * it created, and the Meta ad account it resolves to (UTM ad-set/ad id, else
 * the lead's Meta ad-click touchpoint, else "unmatched/organic").
 *
 * D-23 — this page is now a THIN wrapper over the SHARED platform-leads view
 * (one component, reused 3× by FlexiFunnels / Lovable / TagMango instead of
 * three copies). It resolves ?client= / ?adAccount= exactly as before (the
 * Topbar's existing ad-account dropdown) and the report comes from the
 * shared `platformLeadsReport` (the flexiLeads.ts wrapper is a no-regression
 * alias of the same builder). Live updates: the 60 s `AutoRefresh`.
 */
export const dynamic = "force-dynamic";

export default async function FlexiLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <PlatformLeadsView
      platform="flexifunnels"
      sp={qs(await searchParams)}
    />
  );
}
