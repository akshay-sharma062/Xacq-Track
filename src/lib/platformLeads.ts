/**
 * D-23 — the shared PLATFORM-LEADS report builder (one core, reused 3×).
 *
 * Generalizes the FlexiFunnels "receipt-level" report (src/lib/flexiLeads.ts)
 * into a platform-agnostic `platformLeadsReport(platform, …)` so the Lovable
 * + TagMango tabs reuse the SAME builder + screen instead of copy-pasting
 * flexiLeads 3×. Each platform contributes a small `PlatformFieldSpec` (the
 * per-platform raw-payload shape); the ad-account ATTRIBUTION + the ad-account
 * filter + the KPI + the receipt table are SHARED and platform-independent —
 * they already work for FlexiFunnels and are reused verbatim.
 *
 * The three platforms have DIFFERENT raw shapes (that's the whole point):
 *   flexifunnels : FLAT  (flexiFormFieldsFromRaw — identity + UTM + fbclid + custom)
 *   lovable      : FLAT  (a registration-form POST, D-21; reuses the same
 *                        flat extractor, a form POST is a registered lead,
 *                        never a payment)
 *   tagmango     : NESTED ({ event, order:{ id, amount, product, email, phone } }
 *                        → identity from order.*, value from order.amount,
 *                        txn from order.id, event kind from top-level event)
 *
 * READ-ONLY: this module only reads + shapes data already on disk
 * (WebhookLog.rawPayload, Event.rawPayload, Lead, Touchpoint, Ad/AdSet/
 * AdAccount). It writes NOTHING — no pull rows, no fixed point touched.
 */
import { PrismaClient } from "@prisma/client";
import { maskPhone, Session } from "./session";
import { flexiFormFieldsFromRaw, notesRecord } from "./adapters/payments";

export type PlatformEventKind =
  | "registered"
  | "payment_success"
  | "payment_failed"
  | "refund"
  | "other";

export type PlatformAttribution = "utm" | "meta_touchpoint" | "unmatched";

/** A receipt-level row: one row per platform webhook (WebhookLog), the full
 *  raw payload, the ingested lead it created, and the Meta ad account it
 *  resolves to (attribution: UTM ad-set/ad id → lead's Meta ad-click
 *  touchpoint → unmatched). Generalized from the FlexiLeadRow. */
export interface PlatformLeadRow {
  /** The receipt — one row per webhook (the WebhookLog). */
  logId: string;
  receivedAt: string; // ISO
  webhookStatus: string; // "processed" | "failed" | "duplicate" | …
  eventName: string; // raw `event` / `action` value (optin, order.completed, …)
  eventKind: PlatformEventKind;
  /** Identity exactly as the payload carried it (phone masked per session). */
  identity: { name: string | null; phone: string; email: string | null; city: string | null };
  /** The ingested lead this receipt matched/created, or null (anonymous). */
  lead: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    stage: string;
    sourceUnknown: boolean;
  } | null;
  utm: { source?: string; medium?: string; campaign?: string; content?: string; term?: string; id?: string };
  /** D-24b — WHERE this row's UTM came from (cashfree receipts):
   *  "notes" = the payload's own `notes` (the checkout passed UTM in, task 5);
   *  "lead" = inherited from the matched lead's most recent UTM-carrying
   *  Touchpoint (the cross-platform fallback, task 1); undefined = no UTM
   *  available (honest "—", never faked). Cashfree-only (the other platforms
   *  carry UTM in their native payload, so the indicator would be noise). */
  utmOrigin?: "notes" | "lead";
  /** UTM-extra keys with no Touchpoint column (carried in meta) — platform
   *  specific (FlexiFunnels `utm_flow`); undefined for the others. */
  utmFlow?: string;
  fbclid?: string;
  /** Captured page context (kept out of the "form data" chips). */
  page: { path?: string; landingUrl?: string; sourceUrl?: string; redirectUrl?: string };
  /** The user-named custom fields / unmapped payload fields (PII-masked per
   *  session when the role masks phones). */
  custom: Record<string, unknown>;
  /** Monetary value carried by the receipt (TagMango `order.amount`); null when
   *  the payload has none (FlexiFunnels optin / Lovable registration). */
  value: number | null;
  /** Gateway txn / order id (TagMango `order.id`); null when absent. */
  txnId: string | null;
  adAccount: { id: string; name: string } | null;
  attribution: PlatformAttribution;
  /** The exact raw body as received (pretty-printed by the UI). */
  rawPayload: string;
  parsedPayload: Record<string, unknown> | null; // null = unparseable body
}

export interface PlatformLeadsReport {
  rows: PlatformLeadRow[]; // kept (post ad-account filter), newest first
  totalReceipts: number; // all platform receipts in the client set (pre-filter)
  last24h: number; // kept receipts in the last 24 h
  uniqueLeads: number; // distinct ingested leads among the kept rows
  unmatched: number; // kept receipts with no ad-account attribution (0 when filtered)
  lastReceivedAt: string | null; // newest kept receipt (the "data as of" stamp)
}

/** The per-platform raw-payload shape. The shared builder calls these; the
 *  attribution / filter / KPI / table stay platform-independent. */
export interface PlatformFieldSpec {
  /** Identity exactly as the payload carried it (the builder masks phones). */
  identityFromPayload: (raw: Record<string, unknown>) => {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    city?: string | null;
  };
  /** What KIND of event this receipt is (the badge). */
  eventKindFromPayload: (raw: Record<string, unknown>) => PlatformEventKind;
  /** Monetary value the payload carries (a payment/refund); null if none. */
  valueFromPayload?: (raw: Record<string, unknown>) => number | null;
  /** The gateway txn / order id; null if absent. */
  txnIdFromPayload?: (raw: Record<string, unknown>) => string | null;
  /** The user-named custom fields (the "form data" chips). Unmapped payload
   *  fields that are NOT page-context / UTM-extra. */
  customFields?: (raw: Record<string, unknown>) => Record<string, unknown>;
  /** The UTM values (attribution uses `term`/`id` as the Meta ad-set/ad id). */
  utmFromPayload?: (raw: Record<string, unknown>) => {
    source?: string; medium?: string; campaign?: string; content?: string; term?: string; id?: string;
  };
  /** Captured page context (kept out of the chips). */
  pageFromPayload?: (raw: Record<string, unknown>) => {
    path?: string; landingUrl?: string; sourceUrl?: string; redirectUrl?: string;
  };
  /** UTM-extra with no Touchpoint column (Flexi `utm_flow`). */
  utmFlowFromPayload?: (raw: Record<string, unknown>) => string | undefined;
  /** The Meta ad-click id (the receipt carries fbclid in the UTM params). */
  fbclidFromPayload?: (raw: Record<string, unknown>) => string | undefined;
  /** D-24b — when the payload carries NO UTM, inherit the matched lead's most
   *  recent UTM-carrying Touchpoint's UTM (cross-platform attribution). The
   *  inherited UTM then resolves the ad account through the SAME shared
   *  UTM match (path 1) before the meta_touchpoint fallback (path 2). */
  inheritLeadUtm?: boolean;
}

export type PlatformLeadsPlatform = "flexifunnels" | "lovable" | "tagmango" | "cashfree";

// ---------------------------------------------------------------------------
// Shared small helpers
// ---------------------------------------------------------------------------
const firstStr = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
};
const strOrNull = (...vals: unknown[]): string | null => firstStr(...vals) ?? null;
const numOrNull = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (!Number.isNaN(n)) return n;
  }
  return null;
};

/** PII protection: values that LOOK like a phone / email are masked for a
 *  role that masks phones (spec 5.10) — never expose a raw phone to a masked
 *  role, even when it arrived inside a "custom form answer". Idempotent. */
function looksLikePhone(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return /^\+?[\d\s().-]{7,}$/.test(s) && /\d{5,}/.test(s);
}
function looksLikeEmail(v: unknown): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v ?? "").trim());
}
function maskEmail(raw: string): string {
  const [local, domain] = raw.split("@");
  if (!domain) return "••••";
  return `${local[0] ?? "•"}•••@${domain}`;
}
/** Mask the phone / email-looking values inside a custom-fields object for a
 *  masked role. Non-string + non-PII values pass through as-captured. */
function maskSensitiveValues(custom: Record<string, unknown>, session: Session): Record<string, unknown> {
  if (!session?.maskPhone) return custom; // unmasked role (owner/admin) shows as-captured
  const out: Record<string, unknown> = { ...custom };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v !== "string") continue;
    if (looksLikePhone(v)) out[k] = maskPhone(v, session);
    else if (looksLikeEmail(v)) out[k] = maskEmail(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The three platform specs
// ---------------------------------------------------------------------------

// --- FlexiFunnels: the FLAT shape (reuses the D-19 one-source-of-truth
//     extractor so the report + the adapter + the lead-view card NEVER
//     re-derive the shape). Page-context / UTM-extra keys are kept out of the
//     chips (the exact pre-D-23 behaviour, so /flexi-leads is regression-free).
const FLEXI_FORM_EXCLUDED = new Set([
  "path", "landing_url", "source_url", "redirect_url",
  "utm_flow", "utm_id", "data",
]);
/** The flexi custom chips: the extractor's `custom` minus the page-context /
 *  UTM-extra keys (those surface as named fields, not chip noise). */
function flexiCustomFields(raw: Record<string, unknown>): Record<string, unknown> {
  const f = flexiFormFieldsFromRaw(raw);
  const custom = (f.custom ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(custom)) if (!FLEXI_FORM_EXCLUDED.has(k)) out[k] = v;
  return out;
}
/** Page context is read from the extractor's `custom` / nested `data` (the
 *  pre-D-23 read path, byte-for-byte). */
function flexiPage(raw: Record<string, unknown>): {
  path?: string; landingUrl?: string; sourceUrl?: string; redirectUrl?: string;
} {
  const f = flexiFormFieldsFromRaw(raw);
  const custom = (f.custom ?? {}) as Record<string, unknown>;
  const nested = (custom.data ?? {}) as Record<string, unknown>;
  return {
    path: firstStr(custom.path, nested.path),
    landingUrl: firstStr(custom.landing_url, nested.landing_url),
    sourceUrl: firstStr(custom.source_url, nested.source_url),
    redirectUrl: firstStr(custom.redirect_url, nested.redirect_url),
  };
}
function flexiUtmFlow(raw: Record<string, unknown>): string | undefined {
  const f = flexiFormFieldsFromRaw(raw);
  const custom = (f.custom ?? {}) as Record<string, unknown>;
  const nested = (custom.data ?? {}) as Record<string, unknown>;
  return firstStr(custom.utm_flow, nested.utm_flow);
}
/** FlexiFunnels event kind — mirrors the adapter's own mapping so a receipt's
 *  badge matches the ingested record (optin → registered, purchase →
 *  payment_success, refund → refund). */
function flexiEventKind(raw: Record<string, unknown>): PlatformEventKind {
  const ev = String((raw as any).event ?? (raw as any).action ?? "").toLowerCase().trim();
  if (["order.refunded", "payment.refunded", "payment_refunded", "refund", "refunded"].includes(ev)) return "refund";
  if (["order.paid", "order.completed", "payment.paid", "payment.completed", "payment_success", "purchase", "checkout.completed"].includes(ev) || ev === "") return "payment_success";
  return "registered"; // optin + any unrecognised lead-capture event
}

const FLEXI_SPEC: PlatformFieldSpec = {
  identityFromPayload: (raw) => {
    const f = flexiFormFieldsFromRaw(raw);
    return { name: f.name ?? null, phone: f.phone ?? "", email: f.email ?? null, city: f.city ?? null };
  },
  eventKindFromPayload: flexiEventKind,
  valueFromPayload: (raw) => numOrNull((raw as any).amount, (raw as any).price, (raw as any).order?.amount),
  txnIdFromPayload: (raw) => strOrNull((raw as any).order_id, (raw as any).transaction_id, (raw as any).txn_id, (raw as any).order?.id),
  customFields: flexiCustomFields,
  utmFromPayload: (raw) => flexiFormFieldsFromRaw(raw).utm,
  pageFromPayload: flexiPage,
  utmFlowFromPayload: flexiUtmFlow,
  fbclidFromPayload: (raw) => flexiFormFieldsFromRaw(raw).fbclid,
};

// --- Lovable: the FLAT registration-form shape (D-21). A hand-wired Lovable
//     form POST is a registration, NEVER a payment — so kind is always
//     "registered" and there is no value / txn. Extraction reuses the same
//     flat extractor (FlexiFunnels-compatible) as the D-21 adapter does.
//     Page-context keys for Lovable are its own flat names.
const LOVABLE_PAGE_KEYS = new Set([
  "path", "referrer", "page_url", "source_url", "redirect_url", "utm_flow", "utm_id", "data",
]);
const LOVABLE_SPEC: PlatformFieldSpec = {
  identityFromPayload: (raw) => {
    const f = flexiFormFieldsFromRaw(raw);
    return { name: f.name ?? null, phone: f.phone ?? "", email: f.email ?? null, city: f.city ?? null };
  },
  eventKindFromPayload: () => "registered",
  valueFromPayload: () => null,
  txnIdFromPayload: () => null,
  customFields: (raw) => {
    const f = flexiFormFieldsFromRaw(raw);
    const custom = (f.custom ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(custom)) if (!LOVABLE_PAGE_KEYS.has(k)) out[k] = v;
    return out;
  },
  utmFromPayload: (raw) => flexiFormFieldsFromRaw(raw).utm,
  pageFromPayload: (raw) => ({
    path: firstStr((raw as any).path, (raw as any).page_url),
    sourceUrl: firstStr((raw as any).referrer, (raw as any).source_url),
    landingUrl: firstStr((raw as any).landing_url),
    redirectUrl: firstStr((raw as any).redirect_url),
  }),
  fbclidFromPayload: (raw) => flexiFormFieldsFromRaw(raw).fbclid,
};

// --- TagMango: the NESTED shape. identity from order.*, value from
//     order.amount, txn from order.id, event kind from the top-level `event`.
//     `order.started` is a CHECKOUT (not a payment) → "other"; completed →
//     payment_success; refunded → refund.
const TAGMANGO_IDENTITY_KEYS = new Set(["id", "amount", "phone", "mobile", "email", "name", "city"]);
const TAGMANGO_SPEC: PlatformFieldSpec = {
  identityFromPayload: (raw) => {
    const o = (raw.order ?? {}) as Record<string, unknown>;
    return { name: strOrNull(o.name), phone: firstStr(o.phone, o.mobile) ?? "", email: strOrNull(o.email), city: strOrNull(o.city) };
  },
  eventKindFromPayload: (raw) => {
    const ev = String((raw as any).event ?? "").toLowerCase().trim();
    if (ev === "order.completed") return "payment_success";
    if (ev === "order.refunded") return "refund";
    return "other"; // order.started (checkout) + anything unrecognised
  },
  valueFromPayload: (raw) => numOrNull((raw.order as any)?.amount),
  txnIdFromPayload: (raw) => strOrNull((raw.order as any)?.id),
  customFields: (raw) => {
    const o = (raw.order ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (TAGMANGO_IDENTITY_KEYS.has(k)) continue; // those surface as named fields
      if (v == null || v === "") continue;
      out[k] = v;
    }
    return out;
  },
};

// --- Cashfree: the PAYMENT gateway (D-24b). Cashfree payment webhooks carry
//     NO UTM of their own — the UTM either (1) arrives in the payload's
//     `notes` (the checkout side passes it in, task 5's PO spec — `notes` is
//     a JSON object or a JSON string; the real Cashfree payload also echoes
//     custom tags under `order_tags`) or (2) is INHERITED from the matched
//     lead's most recent UTM-carrying Touchpoint (the `inheritLeadUtm` flag
//     below — task 1 step 2). When the payload has no notes-UTM and no
//     inheritable touchpoint UTM, the row's UTM stays empty (honest "—",
//     never faked). Defensively reads BOTH the real Cashfree shape
//     (snake_case nested under `data`: order/payment/customer_details) and
//     the G4-era camelCase shape already on disk (data.transactionId/…).
const CASHFREE_SPEC: PlatformFieldSpec = {
  inheritLeadUtm: true,
  identityFromPayload: (raw) => {
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const c = (d.customerDetails ?? d.customer_details ?? {}) as Record<string, unknown>;
    return {
      name: strOrNull(c.name, c.customer_name),
      phone: firstStr(c.phone, c.customer_phone) ?? "",
      email: strOrNull(d.customerEmail, c.customer_email),
      city: strOrNull(c.city, c.customer_city),
    };
  },
  eventKindFromPayload: (raw) => {
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const type = String((raw as any).type ?? "").toUpperCase(); // real: PAYMENT_SUCCESS_WEBHOOK, …
    const status = String(d.status ?? d.payment_status ?? d.refund_status ?? "").toUpperCase();
    if (type.startsWith("REFUND") || status === "REFUNDED" || status === "REFUND_SUCCESS") return "refund";
    if (type.startsWith("PAYMENT_FAILED") || type.startsWith("PAYMENT_USER_DROPPED") || status === "FAILED" || status === "USER_DROPPED") return "payment_failed";
    if (type.startsWith("PAYMENT_SUCCESS") || status === "PAID" || status === "SUCCESS") return "payment_success";
    return "other"; // PENDING + anything unrecognised
  },
  valueFromPayload: (raw) => {
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const p = (d.payment ?? {}) as Record<string, unknown>;
    const r = (d.refund ?? {}) as Record<string, unknown>;
    const o = (d.order ?? {}) as Record<string, unknown>;
    // Real Cashfree amounts are in RUPEES (two decimals), not paise. Refund
    // rows read refund_amount; payment rows read payment_amount (→ G4 flat
    // amount / order_amount fallbacks).
    return numOrNull(r.refund_amount, p.payment_amount, d.amount, o.order_amount);
  },
  txnIdFromPayload: (raw) => {
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const p = (d.payment ?? {}) as Record<string, unknown>;
    const r = (d.refund ?? {}) as Record<string, unknown>;
    const o = (d.order ?? {}) as Record<string, unknown>;
    // Prefer the gateway's own id (cf_payment_id / cf_refund_id — the ingest
    // dedup key) → the G4 flat transactionId → order ids.
    return strOrNull(r.cf_refund_id, r.refund_id, p.cf_payment_id, d.transactionId, o.order_id, d.orderId);
  },
  utmFromPayload: (raw) => {
    // Task 1 step 1: UTM from `raw.notes` (object or a JSON string — the
    // notesRecord parser handles both; the checkout side must pass it in,
    // the task-5 PO spec). The real Cashfree payload's `order_tags` (a
    // plain object of merchant custom tags) is a defensive alias — notes
    // wins when both carry the same key.
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const o = (d.order ?? {}) as Record<string, unknown>;
    const notes = notesRecord((raw as any).notes ?? d.notes);
    const tags = ((o.order_tags ?? d.order_tags ?? {}) as Record<string, unknown>);
    const pick = (k: string): string | undefined => firstStr(notes[k], tags[k]);
    // Only-truthy keys, so an UTM-less payload yields {} (the honest
    // "no UTM" case the inherit pass + the "—" indicator key off of).
    const out: Record<string, string | undefined> = {};
    for (const [key, field] of [["source", "utm_source"], ["medium", "utm_medium"], ["campaign", "utm_campaign"], ["content", "utm_content"], ["term", "utm_term"], ["id", "utm_id"]] as const) {
      const v = pick(String(field));
      if (v) out[key] = v;
    }
    return out;
  },
  customFields: (raw) => {
    const d = (raw.data ?? raw) as Record<string, unknown>;
    const o = (d.order ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    const desc = firstStr(d.description, o.order_note, (d as any).product);
    if (desc) out.product = desc;
    return out;
  },
  fbclidFromPayload: undefined, // Cashfree payments carry no fbclid of their own
};

/** The registered field specs, keyed by the WebhookLog.platform value. */
export const PLATFORM_SPECS: Record<PlatformLeadsPlatform, PlatformFieldSpec> = {
  flexifunnels: FLEXI_SPEC,
  lovable: LOVABLE_SPEC,
  tagmango: TAGMANGO_SPEC,
  cashfree: CASHFREE_SPEC,
};

// ---------------------------------------------------------------------------
// The shared builder
// ---------------------------------------------------------------------------
export interface PlatformLeadsOptions {
  platform: PlatformLeadsPlatform;
  clientIds: string[]; // the session's visible set (or the ?client= single)
  adAccountId?: string; // internal AdAccount.id (when ?adAccount= is set)
  session: Session; // for phone masking (spec 5.10)
  limit?: number; // max receipts, default 200
}

export async function platformLeadsReport(
  prisma: PrismaClient,
  opts: PlatformLeadsOptions,
): Promise<PlatformLeadsReport> {
  const empty: PlatformLeadsReport = { rows: [], totalReceipts: 0, last24h: 0, uniqueLeads: 0, unmatched: 0, lastReceivedAt: null };
  if (opts.clientIds.length === 0) return empty;
  const spec = PLATFORM_SPECS[opts.platform];
  const limit = opts.limit ?? 200;
  const { clientIds, session } = opts;

  // --- Meta id → ad account (the UTM match key): ad-set / ad / campaign ids
  //     pulled under the client set, scoped to the selected account when set.
  //     SHARED + platform-independent (the attribution contract, reused verbatim).
  const idWhere = {
    clientId: { in: clientIds },
    ...(opts.adAccountId ? { adAccountId: opts.adAccountId } : {}),
  };
  const [sets, ads, cames, accts] = await Promise.all([
    prisma.adSet.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.ad.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.adCampaign.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.adAccount.findMany({
      where: { clientId: { in: clientIds }, ...(opts.adAccountId ? { id: opts.adAccountId } : {}) },
      select: { id: true, name: true },
    }),
  ]);
  const idToAcct = new Map<string, string>();
  for (const r of [...sets, ...ads, ...cames]) idToAcct.set(r.metaId, r.adAccountId);
  const acctName = new Map(accts.map((a) => [a.id, a.name]));

  // --- The receipts, newest first.
  const where = { platform: opts.platform, clientId: { in: clientIds } };
  const [logs, totalReceipts] = await Promise.all([
    prisma.webhookLog.findMany({
      where, orderBy: { receivedAt: "desc" }, take: limit,
      include: { events: { select: { leadId: true, type: true } } },
    }),
    prisma.webhookLog.count({ where }),
  ]);

  // The ingested leads these receipts created/matched (one batch).
  const leadIds = [...new Set(
    logs.flatMap((l) => l.events.map((e) => e.leadId).filter((v): v is string => Boolean(v))),
  )];
  const leadRows = leadIds.length ? await prisma.lead.findMany({ where: { id: { in: leadIds } } }) : [];
  const leadById = new Map(leadRows.map((l) => [l.id, l]));

  // --- Pass 1: shape every receipt (the spec does the per-platform read).
  const rows: PlatformLeadRow[] = [];
  const rowLeadIds = new Map<number, string | null>();
  for (const log of logs) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const body: unknown = JSON.parse(log.rawPayload || "null");
      parsed = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      parsed = null; // unparseable — the row is still shown, honestly
    }

    // Per-platform read (all no-ops / defaults when the body is unparseable).
    const ident = parsed ? spec.identityFromPayload(parsed) : {};
    const eventKind: PlatformEventKind = parsed ? spec.eventKindFromPayload(parsed) : "other";
    const value = parsed ? (spec.valueFromPayload?.(parsed) ?? null) : null;
    const txnId = parsed ? (spec.txnIdFromPayload?.(parsed) ?? null) : null;
    const custom = parsed ? maskSensitiveValues(spec.customFields?.(parsed) ?? {}, session) : {};
    const utm = parsed ? (spec.utmFromPayload?.(parsed) ?? {}) : {};
    const page = parsed ? (spec.pageFromPayload?.(parsed) ?? {}) : {};
    const utmFlow = parsed ? spec.utmFlowFromPayload?.(parsed) : undefined;
    const fbclid = parsed ? spec.fbclidFromPayload?.(parsed) : undefined;

    const leadId = log.events.map((e) => e.leadId).find(Boolean) ?? null;
    const leadRow = leadId ? leadById.get(leadId) : undefined;

    // 1) UTM attribution: the Meta id lives in `utm.term` (ad level) or
    //    `utm.id` (ad-set level) — try the term first (it is the ad id).
    let adAccountId: string | null = null;
    let attribution: PlatformAttribution = "unmatched";
    for (const cand of [utm.term, utm.id].filter((v): v is string => Boolean(v))) {
      const hit = idToAcct.get(cand);
      if (hit) { adAccountId = hit; attribution = "utm"; break; }
    }

    const row: PlatformLeadRow = {
      logId: log.id,
      receivedAt: log.receivedAt.toISOString(),
      webhookStatus: log.status,
      eventName: strOrNull((parsed as any)?.event, (parsed as any)?.action) ?? "",
      eventKind,
      identity: {
        name: ident.name ?? null,
        phone: ident.phone ? maskPhone(ident.phone, session) : "",
        email: ident.email ?? null,
        city: ident.city ?? null,
      },
      lead: leadRow
        ? {
            id: leadRow.id,
            name: leadRow.name,
            phone: maskPhone(leadRow.phone, session),
            email: leadRow.email,
            stage: leadRow.stage,
            sourceUnknown: leadRow.sourceUnknown,
          }
        : null,
      utm,
      utmFlow,
      fbclid,
      page,
      custom,
      value,
      txnId,
      adAccount: adAccountId ? { id: adAccountId, name: acctName.get(adAccountId) ?? adAccountId } : null,
      attribution,
      rawPayload: log.rawPayload,
      parsedPayload: parsed,
    };
    rows.push(row);
    rowLeadIds.set(rows.length - 1, leadId); // parallel map — the lead a receipt ingested
  }

  // --- Pass 1.5 (D-24b): UTM inheritance from the matched lead's own
  //     touchpoints, for platforms whose payload carries no UTM of its own
  //     (Cashfree — `spec.inheritLeadUtm`). Fallback order (task 1):
  //       1. the payload's own `notes` UTM (checkout passed it in) → "notes";
  //       2. else the matched lead's MOST RECENT UTM-carrying Touchpoint at
  //          or before the receipt (a Lovable lead's original form
  //          submission) → "lead";
  //       3. else nothing (honest "—", never faked).
  //     The inherited UTM then re-runs the shared UTM ad-account match
  //     (path 1) so a cross-platform payment resolves to the SAME ad account
  //     as the lead's original ad-click — before the meta-touchpoint
  //     fallback (pass 2) below.
  const UTM_KEYS = ["source", "medium", "campaign", "content", "term", "id"] as const;
  if (spec.inheritLeadUtm) {
    const inherit: { i: number; leadId: string; atMs: number }[] = [];
    rows.forEach((r, i) => {
      const hasPayloadUtm = UTM_KEYS.some((k) => (r.utm as unknown as Record<string, unknown>)[k]);
      if (hasPayloadUtm) { r.utmOrigin = "notes"; return; } // the payload's own UTM wins
      const lid = rowLeadIds.get(i);
      if (lid) inherit.push({ i, leadId: lid, atMs: new Date(r.receivedAt).getTime() });
    });
    if (inherit.length) {
      const inheritLeadIds = [...new Set(inherit.map((n) => n.leadId))];
      const tps = await prisma.touchpoint.findMany({
        where: {
          leadId: { in: inheritLeadIds },
          OR: [
            { utmSource: { not: null } }, { utmMedium: { not: null } }, { utmCampaign: { not: null } },
            { utmContent: { not: null } }, { utmTerm: { not: null } },
          ],
        },
        select: { leadId: true, timestamp: true, utmSource: true, utmMedium: true, utmCampaign: true, utmContent: true, utmTerm: true },
        orderBy: { timestamp: "desc" }, // most recent first — pick the newest one at/before the receipt
      });
      for (const { i, leadId, atMs } of inherit) {
        const t = tps.find((tp) => tp.leadId === leadId && tp.timestamp.getTime() <= atMs);
        if (!t) continue; // nothing at/before the payment → stays honest "—"
        const inherited = {
          source: t.utmSource ?? undefined,
          medium: t.utmMedium ?? undefined,
          campaign: t.utmCampaign ?? undefined,
          content: t.utmContent ?? undefined,
          term: t.utmTerm ?? undefined,
        };
        if (!Object.values(inherited).some(Boolean)) continue;
        const r = rows[i];
        r.utm = inherited;
        r.utmOrigin = "lead";
        // Re-run the UTM ad-account match (path 1) on the inherited UTM —
        // the inherited ad-set/ad id resolves the SAME account the lead's
        // ad-click came from (task 2's cross-consistency).
        if (r.attribution === "unmatched") {
          for (const cand of [inherited.term].filter((v): v is string => Boolean(v))) {
            const hit = idToAcct.get(cand);
            if (hit) {
              r.adAccount = { id: hit, name: acctName.get(hit) ?? hit };
              r.attribution = "utm";
              break;
            }
          }
        }
      }
    }
  }

  // --- Pass 2: the Meta-touchpoint fallback, batched for the still-unmatched.
  //     The lead's own ad-click touchpoint (adRefId → Ad → AdAccount) carries
  //     the account when the UTM values did not resolve to a pulled ad.
  const unmatchedLeadIds = [...new Set(
    rows.map((r, i) => r.attribution === "unmatched" ? rowLeadIds.get(i) : null)
      .filter((v): v is string => Boolean(v)),
  )];
  if (unmatchedLeadIds.length) {
    const tps = await prisma.touchpoint.findMany({
      where: { leadId: { in: unmatchedLeadIds }, adRefId: { not: null } },
      select: { leadId: true, adRefId: true },
    });
    const adRefByLead = new Map<string, string>();
    for (const t of tps) if (t.leadId && t.adRefId && !adRefByLead.has(t.leadId)) adRefByLead.set(t.leadId, t.adRefId);
    const adRefIds = [...new Set(adRefByLead.values())];
    const adRows = adRefIds.length
      ? await prisma.ad.findMany({ where: { metaId: { in: adRefIds } }, select: { metaId: true, adAccountId: true } })
      : [];
    const adAcctByRef = new Map(adRows.map((a) => [a.metaId, a.adAccountId]));
    rows.forEach((r, i) => {
      if (r.attribution !== "unmatched") return;
      const lid = rowLeadIds.get(i);
      const ref = lid ? adRefByLead.get(lid) : undefined;
      const acc = ref ? adAcctByRef.get(ref) : undefined;
      if (acc) {
        r.adAccount = { id: acc, name: acctName.get(acc) ?? acc };
        r.attribution = "meta_touchpoint";
      }
    });
  }

  // --- Filter + KPIs.
  const kept = opts.adAccountId
    ? rows.filter((r) => r.adAccount?.id === opts.adAccountId) // unmatched drops
    : rows;
  const dayAgo = Date.now() - 86_400_000;
  return {
    rows: kept,
    totalReceipts,
    last24h: kept.filter((r) => new Date(r.receivedAt).getTime() >= dayAgo).length,
    uniqueLeads: new Set(kept.map((r) => r.lead?.id).filter(Boolean)).size,
    unmatched: opts.adAccountId ? 0 : kept.filter((r) => r.attribution === "unmatched").length,
    lastReceivedAt: kept[0]?.receivedAt ?? null,
  };
}
