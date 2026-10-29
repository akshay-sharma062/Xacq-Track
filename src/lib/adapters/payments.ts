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

function notesRecord(notes: unknown): Record<string, string> {
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

export const flexifunnelsAdapter = makeSimpleGatewayAdapter({
  platform: "flexifunnels",
  label: "FlexiFunnels",
  gateway: "flexifunnels",
  sample: { action: "order.paid", order_id: "ff_1", amount: 4999, customer: { email: "v@example.com", phone: "9812340005", name: "Vikram" } },
  statusOf: (p) => (p.action === "order.paid" ? "paid" : p.action === "order.refunded" ? "refunded" : "pending"),
  typeOf: (s) => (s === "refunded" ? "refund" : s === "paid" ? "payment_success" : "payment_failed"),
  extract: (p) => ({ phone: p.customer?.phone, email: p.customer?.email, name: p.customer?.name, gatewayTxnId: p.order_id, value: p.amount, upstreamId: p.order_id }),
});
