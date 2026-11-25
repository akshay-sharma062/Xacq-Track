import { PlatformLeadsView } from "../components/PlatformLeadsView";
import { qs } from "@/lib/api-utils";

/**
 * D-23 — "TagMango Leads": a receipt-level report of every TagMango webhook
 * receipt, rendered by the SHARED platform-leads view (one component, reused
 * 3× — not a copy of the Flexi screen). TagMango is the NESTED shape
 * ({ event, order:{ id, amount, product, email, phone } }): identity comes
 * from order.*, the payment value from order.amount, the txn id from
 * order.id, and the event kind from the top-level `event` (order.completed →
 * Purchase, order.refunded → Refund, order.started → checkout/other). The
 * ad-account filter rides on ?adAccount= via the Topbar's existing dropdown.
 */
export const dynamic = "force-dynamic";

export default async function TagMangoLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <PlatformLeadsView
      platform="tagmango"
      sp={qs(await searchParams)}
    />
  );
}
