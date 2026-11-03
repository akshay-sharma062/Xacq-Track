import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers";
import { processInbound } from "../src/lib/ingest";
import { cashfreeAdapter } from "../src/lib/adapters/payments";

// D-01/D-02: the seed clients are gone. The pipeline is tested against the
// bootstrapped tenancy client (what `pnpm db:seed` now creates). The ad ids in
// the meta payloads are fixture values — adRefId resolution tolerates a
// missing ad row (denormalised, null-safe), so no ad entity is required here.
const FIT = "cl_upcurvv";

function metaLead(phone: string, email: string, adId = "fx_ad_1") {
  return JSON.stringify({
    id: `lead_${phone}`,
    ad_id: adId,
    adset_id: "fx_aset_1",
    campaign_id: "fx_cam_1",
    fields: [
      { name: "What is your name?", value: "Fresh Person" },
      { name: "Phone number", value: phone },
      { name: "Email", value: email },
    ],
    __mapping: { name: "name", phone: "phone", email: "email" },
  });
}
function razorpayPaid(txnId: string, phone: string, amount = 499900) {
  return JSON.stringify({
    event: "payment.captured",
    payment: { id: txnId, order_id: `order_${txnId}`, amount, currency: "INR", status: "captured" },
    notes: { phone, email: `p${phone}@x.com`, name: "Payer", product: "Cohort" },
  });
}
function cashfreePaid(txnId: string, phone: string) {
  return JSON.stringify({
    data: {
      transactionId: txnId, orderId: `o_${txnId}`, amount: 4999, currency: "INR", status: "PAID",
      customerEmail: `p${phone}@x.com`, customerDetails: { phone, name: "Payer" }, description: "Webinar",
    },
    eventId: `evt_${txnId}`, eventDate: "2026-11-03T14:00:00+05:30",
  });
}

describe("ingest e2e (spec 4/5/6: one pipeline, identity, dedup, source-unknown)", () => {
  it("a fresh Meta lead form creates a lead + event + queued CAPI", async () => {
    const { prisma, close } = await freshDb();
    const res = await processInbound({
      prisma, clientId: FIT, platform: "meta", clientSecret: null,
      rawBody: metaLead("9812340099", "fresh@x.com"), headers: {},
    });
    expect(res.status).toBe("processed");
    expect(res.events).toBe(1);
    expect(res.capiQueued).toBe(1); // a "Lead" event is enqueued (spec 5.8)

    const lead = await prisma.lead.findFirst({
      where: { clientId: FIT, phoneNormalized: "+919812340099" },
    });
    expect(lead?.phoneNormalized).toBe("+919812340099");
    const capi = await prisma.outboundEvent.findFirst({
      where: { leadId: lead!.id, type: "Lead" },
    });
    expect(capi?.status).toBe("queued");
    await close();
  });

  it("a Razorpay payment matches the lead by phone, records the sale, and advances to Paid", async () => {
    const { prisma, close } = await freshDb();
    // Seed a lead first (via the pipeline itself).
    await processInbound({
      prisma, clientId: FIT, platform: "meta", clientSecret: null,
      rawBody: metaLead("9812340077", "pay@x.com"), headers: {},
    });
    const res = await processInbound({
      prisma, clientId: FIT, platform: "razorpay", clientSecret: null,
      rawBody: razorpayPaid("rzp_new_1", "9812340077"), headers: {},
    });
    expect(res.status).toBe("processed");
    expect(res.payments).toBe(1);

    const pay = await prisma.payment.findFirst({
      where: { gateway: "razorpay", gatewayTxnId: "rzp_new_1" },
    });
    expect(pay?.status).toBe("paid");
    expect(pay?.amount).toBe(4999); // 499900 paise / 100
    const lead = await prisma.lead.findFirst({ where: { phoneNormalized: "+919812340077", clientId: FIT } });
    expect(lead?.stage).toBe("Paid"); // auto stage move (spec 5.5)
    const purchase = await prisma.outboundEvent.findFirst({ where: { type: "Purchase", dedupKey: { contains: "rzp_new_1" } } });
    expect(purchase?.status).toBe("queued");
    await close();
  });

  it("a duplicate gateway txn is NOT recorded twice (spec 6)", async () => {
    const { prisma, close } = await freshDb();
    const ctx = { prisma, clientId: FIT, platform: "razorpay" as const, clientSecret: null, headers: {} };
    await processInbound({ ...ctx, rawBody: razorpayPaid("rzp_dup", "9812340055") });
    await processInbound({ ...ctx, rawBody: razorpayPaid("rzp_dup", "9812340055") }); // replay
    // Exactly one row despite two identical webhooks (the DB unique
    // [gateway, gatewayTxnId] + the pipeline's findUnique guard).
    const rows = await prisma.payment.findMany({
      where: { gateway: "razorpay", gatewayTxnId: "rzp_dup" },
    });
    expect(rows).toHaveLength(1);
    await close();
  });

  it("one lead paying through two gateways enqueues two CAPI events without a eventId collision (G4)", async () => {
    // Regression for the G4-replay 502: OutboundEvent.eventId is @unique and
    // was stored as dedupKey.slice(0,64). Two Purchase CAPI events for the SAME
    // lead across different gateways share a `Purchase:<client>:<phone>:<txn…>`
    // prefix, so their 64-char truncations collided and the second create 502'd.
    // The fix stores the full (already-unique) dedupKey, so both must land.
    const { prisma, close } = await freshDb();
    const phone = "9812340070";
    const rzp = await processInbound({
      prisma, clientId: FIT, platform: "razorpay", clientSecret: null,
      rawBody: razorpayPaid("tz_gate_1", phone), headers: {},
    });
    const cf = await processInbound({
      prisma, clientId: FIT, platform: "cashfree", clientSecret: null,
      rawBody: cashfreePaid("cf_gate_2", phone), headers: {},
    });
    // Both webhooks processed (no 502 / "failed" from a constraint violation).
    expect(rzp.status).toBe("processed");
    expect(cf.status).toBe("processed");
    const purchases = await prisma.outboundEvent.findMany({ where: { type: "Purchase" } });
    // Two distinct CAPI Purchase events, two distinct dedup + event ids.
    expect(purchases).toHaveLength(2);
    expect(new Set(purchases.map((e) => e.dedupKey)).size).toBe(2);
    expect(new Set(purchases.map((e) => e.eventId)).size).toBe(2);
    await close();
  });

  it("a refund creates a refunded row + a skipped CAPI Refund note (spec 5.8)", async () => {
    const { prisma, close } = await freshDb();
    const refundBody = JSON.stringify({
      event: "payment.refunded",
      payment: { id: "rzp_ref_9", amount: 499900, currency: "INR", status: "refunded" },
      notes: { phone: "9812340033" },
    });
    const res = await processInbound({
      prisma, clientId: FIT, platform: "razorpay", clientSecret: null, rawBody: refundBody, headers: {},
    });
    expect(res.status).toBe("processed");
    const pay = await prisma.payment.findUnique({
      where: { gateway_gatewayTxnId: { gateway: "razorpay", gatewayTxnId: "rzp_ref_9" } },
    });
    expect(pay?.status).toBe("refunded");
    const capi = await prisma.outboundEvent.findFirst({
      where: { type: "Refund", dedupKey: { contains: "+919812340033" } },
    });
    // Spec: never SEND a Purchase for a refund — it is a skipped note, not a send.
    expect(capi?.status).toBe("skipped");
    await close();
  });

  it("a payment with no matching lead creates a source-unknown lead that still counts in revenue (spec 6)", async () => {
    const { prisma, close } = await freshDb();
    await processInbound({
      prisma, clientId: FIT, platform: "razorpay", clientSecret: null,
      rawBody: razorpayPaid("rzp_walkin", "9812340066"), headers: {},
    });
    const lead = await prisma.lead.findFirst({ where: { phoneNormalized: "+919812340066", clientId: FIT } });
    expect(lead?.sourceUnknown).toBe(true);
    const pay = await prisma.payment.findFirst({ where: { leadId: lead!.id, status: "paid" } });
    expect(pay?.amount).toBe(4999);
    await close();
  });

  it("rejects a webhook that fails signature verification (spec 10)", async () => {
    const { prisma, close } = await freshDb();
    const body = JSON.stringify(cashfreeAdapter.sample);
    // Non-null secret -> verify() runs; we give it a wrong signature.
    const res = await processInbound({
      prisma, clientId: FIT, platform: "cashfree", clientSecret: "whsec_test_000",
      rawBody: body,
      headers: { "cf-signature": "0000", "cf-timestamp": "0", rawBody: body },
    });
    expect(res.status).toBe("failed");
    const log = await prisma.webhookLog.findFirst({
      where: { status: "failed", platform: "cashfree" },
    });
    expect(log?.error).toMatch(/verification failed/);
    await close();
  });

  it("logs every inbound webhook with its status (spec 5.6)", async () => {
    const { prisma, close } = await freshDb();
    await processInbound({
      prisma, clientId: FIT, platform: "meta", clientSecret: null,
      rawBody: metaLead("9812340088", "log@x.com"), headers: {},
    });
    // Newest first — no seed webhook rows exist now; the pipeline's own log
    // is the one we assert (spec 4: raw kept for re-processing).
    const log = await prisma.webhookLog.findFirst({
      where: { platform: "meta", status: "processed" },
      orderBy: { receivedAt: "desc" },
    });
    expect(log?.rawPayload).toMatch("9812340088");
    await close();
  });
});
