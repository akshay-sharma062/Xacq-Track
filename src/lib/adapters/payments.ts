/**
 * Payment-gateway adapters: Razorpay, Cashfree, Cosmofeed, TagMango, FlexiFunnels.
 * (spec 6 — events: payment_success, payment_failed, refund; match key
 * phone/email; dedup on gateway transaction id; a payment with no matching
 * lead creates a "source unknown" lead that still counts in revenue.)
 *
 * Each adapter carries its own SAVED SAMPLE PAYLOAD (spec 8) and a signature
 * verifier where the gateway provides one (Razorpay HMAC, Cashfree HMAC).
 * Phone/email in India usually arrive only inside the gateway's `notes` or
 * `customer` object, so we read both shapes defensively.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Adapter, NormalizedInbound } from "./types";

function hmacHex(key: string, body: string): string {
  return createHmac("sha256", key).update(body, "utf8").digest("hex");
}
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function notesRecord(notes: unknown): Record<string, string> {
  if (typeof notes === "string") {
    try { return JSON.parse(notes); } catch { return {}; }
  }
  return (notes && typeof notes === "object" ? notes : {}) as Record<string, string>;
}
function extractIdentity(p: any): { phone?: string; email?: string; name?: string; product?: string } {
  const notes = notesRecord(p.notes);
  const customer = p.customer ?? {};
  return {
    phone: notes.phone ?? p.customer_phone ?? p.phone ?? customer.phone,
    email: notes.email ?? p.customer_email ?? p.email ?? customer.email,
    name: notes.name ?? p.customer_name ?? p.name ?? customer.name,
    product: notes.product ?? p.product ?? p.product_name,
  };
}

// ---------------------------------------------------------------------------
// Razorpay (HMAC SHA-256 of the raw body over the webhook secret)
// ---------------------------------------------------------------------------
const RAZORPAY_SAMPLE = {
  event: "payment.captured",
  payment: {
    id: "pay_Rzp0001",
    order_id: "order_0001",
    amount: 2499900, // paise
    currency: "INR",
    status: "captured",
  },
  notes: { phone: "9812340001", email: "rakesh@example.com", name: "Rakesh Kumar", product: "Mentorship cohort" },
};

export const razorpayAdapter: Adapter = {
  platform: "razorpay",
  label: "Razorpay",
  sample: RAZORPAY_SAMPLE,
  verify(payload, headers, secret) {
    if (!secret) return true; // dev: unsigned
    const provided = headers["x-razorpay-signature"];
    if (!provided || headers.rawBody === undefined) return false;
    const expected = hmacHex(secret, String(headers.rawBody));
    return safeEqual(expected, provided);
  },
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const id = extractIdentity(p);
    const ev = p.event;
    const amount = p.payment?.amount; // paise
    const txnId = p.payment?.id ?? p.order?.order_id;
    const status: NormalizedInbound["status"] =
      ev === "payment.captured" ? "paid"
      : ev === "payment.failed" ? "failed"
      : ev === "payment.refunded" ? "refunded"
      : "pending";
    const type: NormalizedInbound["type"] =
      status === "refunded" ? "refund" : status === "paid" ? "payment_success" : "payment_failed";
    return [{
      platform: "razorpay",
      type,
      phone: id.phone, email: id.email, name: id.name, product: id.product,
      gateway: "razorpay",
      gatewayTxnId: txnId,
      value: amount != null ? amount / 100 : null,
      currency: p.payment?.currency ?? "INR",
      status,
      upstreamId: txnId,
      occurredAt: p.created_at,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// Cashfree (HMAC SHA-256 of `${timestamp}:${payload}` over the shared secret)
// ---------------------------------------------------------------------------
const CASHFREE_SAMPLE = {
  "data": {
    "transactionId": "cf_txn_002",
    "orderId": "ord_0002",
    "amount": 4999,
    "currency": "INR",
    "status": "PAID",
    "customerEmail": "priya@example.com",
    "customerDetails": { "phone": "9812340002", "name": "Priya Nair" },
    "description": "Webinar pass"
  },
  "eventId": "evt_0002",
  "eventDate": "2024-05-03T14:00:00+05:30",
};

export const cashfreeAdapter: Adapter = {
  platform: "cashfree",
  label: "Cashfree",
  sample: CASHFREE_SAMPLE,
  verify(payload, headers, secret) {
    if (!secret) return true;
    const provided = headers["cf-signature"];
    const ts = headers["cf-timestamp"] ?? "0";
    if (!provided) return false;
    const body = typeof payload === "string" ? payload : JSON.stringify(payload);
    const expected = hmacHex(secret, `${ts}:${body}`);
    return safeEqual(expected, provided);
  },
  parse(payload: unknown): NormalizedInbound[] {
    const d = (payload as any).data ?? payload;
    const c = d.customerDetails ?? {};
    const statusMap: Record<string, NormalizedInbound["status"]> = { PAID: "paid", FAILED: "failed", REFUNDED: "refunded", PENDING: "pending" };
    const status = statusMap[d.status] ?? "pending";
    const type: NormalizedInbound["type"] =
      status === "refunded" ? "refund" : status === "paid" ? "payment_success" : "payment_failed";
    return [{
      platform: "cashfree",
      type,
      phone: c.phone, email: d.customerEmail ?? c.email, name: c.name, product: d.description,
      gateway: "cashfree",
      gatewayTxnId: d.transactionId,
      value: d.amount, currency: d.currency ?? "INR",
      status,
      upstreamId: d.transactionId,
      occurredAt: (payload as any).eventDate,
      raw: payload,
    }];
  },
};

// ---------------------------------------------------------------------------
// Cosmofeed / TagMango / FlexiFunnels (no stable signature in first version —
// verify by shared `X-Webhook-Secret` header instead, see verify helper).
// ---------------------------------------------------------------------------
function makeSimpleGatewayAdapter(opts: {
  platform: NormalizedInbound["platform"];
  label: string;
  gateway: string;
  sample: unknown;
  statusOf: (p: any) => NormalizedInbound["status"];
  typeOf: (status: string) => NormalizedInbound["type"];
  extract: (p: any) => Partial<NormalizedInbound>;
}): Adapter {
  return {
    platform: opts.platform,
    label: opts.label,
    sample: opts.sample,
    verify(_p, headers, secret) {
      if (!secret) return true; // unsigned dev default
      return headers["x-webhook-secret"] === secret;
    },
    parse(payload: unknown): NormalizedInbound[] {
      const p = payload as any;
      const status: NormalizedInbound["status"] = opts.statusOf(p);
      const type = opts.typeOf(status ?? "pending");
      const extra = opts.extract(p);
      // An extractor may omit `type` (e.g. TagMango only sets it for
      // order.started). Restore the computed type so the spread can't clobber it
      // with `undefined`.
      if (extra.type === undefined) extra.type = type;
      return [{
        platform: opts.platform,
        type,
        gateway: opts.gateway,
        currency: "INR",
        status,
        ...extra,
        raw: p,
      }];
    },
  };
}

export const cosmofeedAdapter = makeSimpleGatewayAdapter({
  platform: "cosmofeed",
  label: "Cosmofeed",
  gateway: "cosmofeed",
  sample: { order_id: "cosmo_o1", amount: 4999, status: "completed", buyer: { email: "a@example.com", phone: "9812340003", name: "Buyer", product: "Workbook" } },
  statusOf: (p) => (p.status === "completed" ? "paid" : p.status === "refunded" ? "refunded" : "pending"),
  typeOf: (s) => (s === "refunded" ? "refund" : s === "paid" ? "payment_success" : "payment_failed"),
  extract: (p) => ({ phone: p.buyer?.phone, email: p.buyer?.email, name: p.buyer?.name, product: p.buyer?.product, gatewayTxnId: p.order_id, value: p.amount, upstreamId: p.order_id }),
});

export const tagmangoAdapter = makeSimpleGatewayAdapter({
  platform: "tagmango",
  label: "TagMango",
  gateway: "tagmango",
  sample: { event: "order.completed", order: { id: "tm_100", amount: 9999, product: "Masterclass", email: "s@example.com", phone: "9812340004" } },
  statusOf: (p) => (p.event === "order.refunded" ? "refunded" : p.event === "order.completed" ? "paid" : p.event === "order.started" ? "pending" : "pending"),
  typeOf: (s) => (s === "refunded" ? "refund" : s === "paid" ? "payment_success" : "checkout_started"),
  extract: (p) => ({ phone: p.order?.phone, email: p.order?.email, product: p.order?.product, gatewayTxnId: p.order?.id, value: p.order?.amount, upstreamId: p.order?.id, type: p.event === "order.started" ? "checkout_started" : undefined }),
});

// ---------------------------------------------------------------------------
// FlexiFunnels — the REAL payload shape (D-19, captured from live WebhookLog
// rows 2026-11-17): a FLAT lead-capture object, NOT the {action:"order.paid",
// customer:{...}} shape D-13/D-06 assumed and NOT the {event,payload:{data}}
// envelope the spec guessed. Real keys (optin / lead-capture webhook):
//   first_name, email, phone, city, <user-named custom fields e.g.
//   "what's_your_current_it">, utm_source/medium/campaign/term/content/id/flow,
//   path, landing_url, redirect_url, source_url, fbclid, datetime
//   ("dd/MM/yyyy, hh:mm:ss am/pm" — IST), event: "optin".
// D-19 maps it to `registered` (a lead-capture event, NOT a payment — the
// pre-D-19 bug mapped every optin to payment_failed and created source-unknown
// leads with no identity). The purchase path (Products → Product Rules →
// Webhook) is assumed to carry an order/purchase-family event with amount +
// an order/txn id (the D-13 legacy shape is kept working as a tolerance);
// the real purchase envelope is "assumed — verify against a live capture".
// Identity + UTM + fbclid are read from BOTH the flat top level and a nested
// payload.data / data envelope (FlexiFunnels envelopes vary by event type),
// and the legacy customer object (never clobbering a top-level value).
// Custom form answers (e.g. "what's_your_current_it") are NOT columns on
// Lead — they stay in WebhookLog.rawPayload (spec 4: raw kept for
// re-processing) via the record's `raw`.
// ---------------------------------------------------------------------------

/** A real-shape FlexiFunnels lead-capture (optin) sample — the D-19 test
 *  replay payload. PII is a test fixture, not a captured real person. */
export const FLEXI_OPTIN_SAMPLE = {
  first_name: "Priya",
  email: "priya.optin@example.com",
  phone: "+919812340005",
  city: "Mumbai",
  "what's_your_current_it": "Data Analyst",
  utm_source: "Foremost Leads | CBO | 21th Sept | Carousel 10 v2 | 31 Oct",
  utm_medium: "Ad Set 1 v2 | 31 Oct",
  utm_campaign: "Instagram_Reels",
  utm_term: "120250090382550032",
  utm_content: "Caraousel 10",
  utm_id: "120250090379420032",
  utm_flow: "",
  path: "/vpaxdvju",
  landing_url: "https://join.example.com/vpaxdvju",
  redirect_url: "https://join.example.com/3zx0t3gz",
  source_url: "https://join.example.com/vpaxdvju",
  fbclid: "PAZXh0_EXAMPLE_FBCLID_0001",
  datetime: "17/11/2026, 10:53:56 am",
  event: "optin",
};

/** FlexiFunnels event-name families (lowercased). `optin` is the LIVE-captured
 *  value. Known lead-capture spellings (optin / opt_in / lead / form_submitted
 *  / signup / registration / webhook_trigger) all map to `registered`; and so
 *  does ANY unrecognised event name — the D-19 rule is "a FlexiFunnels form
 *  webhook is a registration unless it names a purchase or refund", so an
 *  unknown future event degrades to a lead, never a fake payment. */
const FLEXI_REFUND_EVENTS = new Set(["order.refunded", "payment.refunded", "payment_refunded", "refund", "refunded"]);
const FLEXI_PURCHASE_EVENTS = new Set(["order.paid", "order.completed", "payment.paid", "payment.completed", "payment_success", "purchase", "checkout.completed"]);

/** Top-level FlexiFunnels keys already mapped onto a NAMED NormalizedInbound
 *  property (identity / attribution / purchase / event). Every OTHER top-level
 *  key (the user-named custom form fields like "what's_your_current_it", the
 *  page context like path/landing_url, utm_id/utm_flow, …) is carried in the
 *  record's `meta` so no field is lost (spec: "carry them as a meta object"). */
const FLEXI_CONSUMED = new Set([
  "phone", "mobile", "contact", "whatsapp_number", "phone_number",
  "email", "name", "first_name", "city",
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid",
  "order_id", "transaction_id", "txn_id", "amount", "price", "product", "product_name",
  "event", "action", "customer", "payload", "data", "datetime", "created_at",
]);

/** Build the record's `meta` from the leftover top-level keys (the custom form
 *  answers + page context not already mapped). Empty → null. */
function flexiMeta(p: Record<string, unknown>, data: Record<string, unknown> | null): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (FLEXI_CONSUMED.has(k)) continue;
    if (v == null || v === "") continue;
    out[k] = v;
  }
  // Also fold in the nested data envelope's custom fields (envelope shape),
  // namespaced under `data` so a top-level + nested same-name never collide.
  if (data) {
    const nested: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (FLEXI_CONSUMED.has(k)) continue;
      if (v == null || v === "") continue;
      nested[k] = v;
    }
    if (Object.keys(nested).length) out.data = nested;
  }
  // `undefined` (not null) so it matches NormalizedInbound.meta? (optional).
  return Object.keys(out).length ? out : undefined;
}

/** Parse FlexiFunnels' `datetime` ("17/11/2026, 10:53:56 am" — IST) into a
 *  Date. ISO/number inputs parse normally; anything unparseable → null (the
 *  ingest falls back to `new Date()`, never a crash). */
export function parseFlexiDatetime(v: unknown): Date | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || typeof v === "string") {
    const d = new Date(v);
    if (!isNaN(d.getTime()) && !/^\d{1,2}\/\d{1,2}\/\d{4}/.test(String(v))) return d;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*,?\s*(\d{1,2}):(\d{2}):(\d{2})\s*(am|pm)?$/i.exec(String(v).trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss, mer] = m;
  let hour = Number(hh);
  const mer2 = mer?.toLowerCase();
  if (mer2 === "pm" && hour < 12) hour += 12;
  if (mer2 === "am" && hour === 12) hour = 0;
  // FlexiFunnels timestamps are IST (UTC+5:30): build the UTC instant from the
  // wall-clock time minus the offset.
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), hour, Number(mi), Number(ss), 0) - 5.5 * 3600 * 1000;
  const d = new Date(utc);
  return isNaN(d.getTime()) ? null : d;
}

function flexiFirst(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function flexiData(p: any): Record<string, unknown> | null {
  // The ticket-guessed envelope: { payload: { data: {...} } } (or a flat data).
  const d = p?.payload?.data ?? p?.data ?? null;
  return d && typeof d === "object" ? (d as Record<string, unknown>) : null;
}

/** D-19b: the reusable flat-shape extractor. Given a raw FlexiFunnels body
 *  (flat optin, a `payload.data` / `data` envelope, or the legacy `customer`
 *  object — whichever the provider sent), returns the identity + UTM +
 *  fbclid + custom-fields the adapter itself uses, so the lead-view "Form
 *  data" card and the backfill script NEVER re-derive the shape (the ticket's
 *  "same flat shape" guarantee): one source of truth, in the adapter. */
export function flexiFormFieldsFromRaw(raw: unknown): {
  phone?: string;
  email?: string;
  name?: string;
  city?: string;
  utm: { source?: string; medium?: string; campaign?: string; content?: string; term?: string; id?: string };
  fbclid?: string;
  custom: Record<string, unknown>;
} {
  const p = (raw ?? {}) as Record<string, unknown>;
  const data = flexiData(p);
  const customer = (p.customer ?? data?.customer ?? {}) as Record<string, unknown>;
  const utm = {
    source: flexiFirst(p.utm_source, data?.utm_source),
    medium: flexiFirst(p.utm_medium, data?.utm_medium),
    campaign: flexiFirst(p.utm_campaign, data?.utm_campaign),
    content: flexiFirst(p.utm_content, data?.utm_content),
    term: flexiFirst(p.utm_term, data?.utm_term),
    id: flexiFirst(p.utm_id, data?.utm_id),
  };
  return {
    phone: flexiFirst(p.phone, p.mobile, p.contact, p.whatsapp_number, data?.phone, data?.mobile, data?.contact, customer.phone, customer.phone_number),
    email: flexiFirst(p.email, data?.email, customer.email),
    name: flexiFirst(p.name, data?.name, customer.name, p.first_name, data?.first_name, customer.first_name),
    city: flexiFirst(p.city, data?.city, customer.city),
    utm,
    fbclid: flexiFirst(p.fbclid, data?.fbclid),
    custom: flexiMeta(p, data) ?? {},
  };
}

export const flexifunnelsAdapter: Adapter = {
  platform: "flexifunnels",
  label: "FlexiFunnels",
  sample: FLEXI_OPTIN_SAMPLE,
  // D-18: header-less platform — verify is the shared x-webhook-secret check
  // (unsigned when the connection secret is empty).
  verify(_p, headers, secret) {
    if (!secret) return true; // unsigned dev default / D-18 unsigned connections
    return headers["x-webhook-secret"] === secret;
  },
  parse(payload: unknown): NormalizedInbound[] {
    const p = (payload ?? {}) as any;
    const data = flexiData(p);
    const customer = p.customer ?? data?.customer ?? {};
    const ev = String(p.event ?? p.action ?? data?.event ?? "").toLowerCase().trim();

    // Identity: flat top level first (the real shape), then the nested data
    // envelope, then the legacy customer object. Top-level values never get
    // clobbered by nested ones.
    const phone = flexiFirst(p.phone, p.mobile, p.contact, p.whatsapp_number, data?.phone, data?.mobile, data?.contact, customer.phone, customer.phone_number);
    const email = flexiFirst(p.email, data?.email, customer.email);
    const name = flexiFirst(p.name, data?.name, customer.name, p.first_name, data?.first_name, customer.first_name);
    const city = flexiFirst(p.city, data?.city, customer.city);

    // Attribution carry-through (the real optin payload carries all five UTM
    // fields + fbclid; ingest turns these into a touchpoint on the lead).
    const utmSource = flexiFirst(p.utm_source, data?.utm_source);
    const utmMedium = flexiFirst(p.utm_medium, data?.utm_medium);
    const utmCampaign = flexiFirst(p.utm_campaign, data?.utm_campaign);
    const utmContent = flexiFirst(p.utm_content, data?.utm_content);
    const utmTerm = flexiFirst(p.utm_term, data?.utm_term);
    const fbclid = flexiFirst(p.fbclid, data?.fbclid);

    // Purchase-family fields (the assumed purchase envelope; absent on optin).
    const amount = p.amount ?? p.price ?? data?.amount ?? p.order?.amount;
    const txn = p.order_id ?? p.transaction_id ?? p.txn_id ?? data?.order_id ?? data?.transaction_id ?? p.order?.id;
    const product = flexiFirst(p.product, p.product_name, data?.product, customer.product);

    const base = {
      platform: "flexifunnels" as const,
      gateway: "flexifunnels" as const,
      currency: "INR" as const,
      phone, email, name, city,
      utmSource, utmMedium, utmCampaign, utmContent, utmTerm, fbclid,
      occurredAt: parseFlexiDatetime(p.datetime ?? data?.datetime ?? p.created_at) ?? undefined,
      // D-19: carry every unmapped top-level field (the user-named custom form
      // answers + page context) so no field is lost — it persists on the
      // timeline Event's rawPayload.meta + the full body stays on WebhookLog.
      meta: flexiMeta(p as Record<string, unknown>, data),
      raw: p,
    };

    if (FLEXI_REFUND_EVENTS.has(ev)) {
      return [{ ...base, type: "refund", status: "refunded", value: amount ?? null, gatewayTxnId: txn, product, upstreamId: txn ?? null }];
    }
    if (FLEXI_PURCHASE_EVENTS.has(ev) || ev === "") {
      // A purchase-family event (or the legacy no-`event` purchase payload the
      // D-13/D-06 replay tools still emit) → payment_success. No gateway txn
      // means no dedup row, but the record still lands.
      return [{ ...base, type: "payment_success", status: "paid", value: amount ?? null, gatewayTxnId: txn, product, upstreamId: txn ?? null }];
    }
    // Lead-capture (the live-captured "optin" + tolerant aliases) — and the
    // DEFAULT for any unrecognised event name too: a FlexiFunnels form webhook
    // is a REGISTRATION, not a payment. This is the D-19 fix — pre-fix,
    // unknown events fell through to status "pending" → type "payment_failed"
    // and created source-unknown leads with no identity.
    return [{ ...base, type: "registered", status: "pending", upstreamId: txn ?? null }];
  },
};
