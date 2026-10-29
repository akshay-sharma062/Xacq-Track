/**
 * Retention rules (spec tab A + section 10).
 *
 * The exact per-table retention days are a product decision that must be
 * confirmed by the legal/compliance owner before the pilot goes live (spec 10).
 * We encode the defaults here as the single source of truth so the cleanup job,
 * the audit screen and any manual export all agree. Values are intentionally
 * conservative: raw data is kept long enough to be useful, short enough that
 * "one leak doesn't hurt every client at once" (spec 10) is achievable.
 *
 * Two invariants the caller (the cleanup job) enforces, not us:
 *   - Webhook raw payloads are always kept at least as long as the events they
 *     produced, so a failed event can be re-processed (spec 4 / 5.6).
 *   - Deleted leads (deletedAt set) stop receiving future CAPI immediately;
 *     their historical rows are then aged out below.
 */

export interface RetentionPolicy {
  /** prisma model / table name. */
  table: string;
  /** keep rows for N days from their natural timestamp column. */
  days: number;
  /** the timestamp column the clock runs from. */
  clockColumn: string;
  note: string;
}

export const RETENTION: RetentionPolicy[] = [
  {
    table: "WebhookLog",
    days: 400, // ~13 months of raw payloads for re-processing + audit.
    clockColumn: "receivedAt",
    note: "Keep raw payloads long enough to replay a failed event (spec 5.6).",
  },
  {
    table: "Event",
    days: 730, // 2 years of timeline (journeys can be long for coaching).
    clockColumn: "timestamp",
    note: "Lead timeline history.",
  },
  {
    table: "Payment",
    days: 1825, // 5 years — financial records, gateway reconciliation.
    clockColumn: "paidAt",
    note: "Money rows kept longest (revenue gate, spec 9).",
  },
  {
    table: "Spend",
    days: 730, // 2 years of ad performance, enough for YoY.
    clockColumn: "day",
    note: "Daily ad spend, INR + native.",
  },
  {
    table: "OutboundEvent",
    days: 400, // CAPI send log incl. match quality.
    clockColumn: "createdAt",
    note: "CAPI dedup + match-quality history.",
  },
  {
    table: "AuditLog",
    days: 365, // who viewed/exported/changed what, 1 year.
    clockColumn: "at",
    note: "Spec 5.10 / 10: audit of exports + phone access.",
  },
];

/**
 * Compute which rows of a table are now past their retention window, as a
 * timestamp to compare against. Exposed as a pure helper so tests can assert
 * "after date X, rows with clock < Y are purgeable" without a live DB.
 */
export function retentionCutoff(
  table: string,
  now: Date,
  overrideDays?: Record<string, number>
): Date | null {
  const pol = RETENTION.find((p) => p.table === table);
  if (!pol) return null; // table not subject to retention
  const days = overrideDays?.[table] ?? pol.days;
  return new Date(now.getTime() - days * 86_400_000);
}

/** Which policies exist (for the audit/settings screen to display). */
export function retentionPolicies(): RetentionPolicy[] {
  return RETENTION.map((p) => ({ ...p }));
}
