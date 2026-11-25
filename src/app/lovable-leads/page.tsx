import { PlatformLeadsView } from "../components/PlatformLeadsView";
import { qs } from "@/lib/api-utils";

/**
 * D-23 — "Lovable Leads": a receipt-level report of every Lovable webhook
 * receipt, rendered by the SHARED platform-leads view (one component, reused
 * 3× — not a copy of the Flexi screen). Lovable is an unsigned flat
 * registration-form host (D-21): a form POST is a registered lead, never a
 * payment, so the event badge is "Lead capture" + the chips are the user-named
 * form fields. The ad-account filter rides on ?adAccount= via the Topbar's
 * existing dropdown.
 */
export const dynamic = "force-dynamic";

export default async function LovableLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <PlatformLeadsView
      platform="lovable"
      sp={qs(await searchParams)}
    />
  );
}
