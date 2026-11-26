import { PlatformLeadsView } from "../components/PlatformLeadsView";
import { qs } from "@/lib/api-utils";

/**
 * D-24b — "CashFree Leads": a receipt-level report of every CashFree payment
 * webhook receipt, rendered by the SHARED platform-leads view (one component,
 * reused across the FlexiFunnels / Lovable / TagMango / CashFree tabs — not
 * another copy). CashFree is the PAYMENT gateway: identity from the customer
 * details, the value from the amount (rupees, not paise), the txn id from the
 * gateway's own payment/refund id, and the event kind from the status
 * (PAID → Purchase, FAILED/USER_DROPPED → Payment failed, REFUNDED → Refund).
 *
 * UTM cross-platform inheritance (D-24b, task 1+2): a CashFree receipt
 * carries no UTM of its own, so it inherits the UTM + ad account from the
 * matched lead's most-recent UTM-carrying Touchpoint (a Lovable-sourced lead
 * who pays via CashFree), or from the payload's own `notes` when the checkout
 * side passes UTM in (task 5). The row shows a source indicator: "notes" /
 * "lead" / "—". The ad-account filter rides on ?adAccount= via the Topbar's
 * existing dropdown.
 */
export const dynamic = "force-dynamic";

export default async function CashFreeLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  return (
    <PlatformLeadsView
      platform="cashfree"
      sp={qs(await searchParams)}
    />
  );
}
