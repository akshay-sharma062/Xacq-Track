import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { ADAPTERS, adapterCatalog, adapterFor } from "../src/lib/adapters";
import type { NormalizedInbound } from "../src/lib/adapters";

/**
 * Spec rule 8 / tab H: "Every webhook handler gets a saved sample payload and
 * a test that replays it." This file replays every adapter's stored `sample`
 * through `parse()` and asserts the normalised output, so a future payload
 * shape change fails the test instead of silently breaking a client's leads.
 */

function parseSample(platform: keyof typeof ADAPTERS): NormalizedInbound[] {
  return adapterFor(platform).parse(ADAPTERS[platform].sample);
}

describe("adapters — every platform replays its saved sample (spec 8)", () => {
  it("Meta Instant Form -> meta_form_lead with ad ids + identity", () => {
    const [r] = parseSample("meta");
    expect(r?.type).toBe("meta_form_lead");
    expect(r?.adId).toBe("ad_103");
    expect(r?.campaignId).toBe("cam_launch");
    expect(r?.phone).toBe("98 1234 0008"); // raw; ingest normalises
    expect(r?.name).toBe("Rohit Iyer");
    expect(r?.fbc).toBeUndefined(); // no fbclid in this sample
  });

  it("Razorpay -> payment_success, paise->INR, txn id for dedup", () => {
    const [r] = parseSample("razorpay");
    expect(r?.type).toBe("payment_success");
    expect(r?.gateway).toBe("razorpay");
    expect(r?.gatewayTxnId).toBe("pay_Rzp0001");
    expect(r?.value).toBe(24999); // 2499900 paise / 100
    expect(r?.status).toBe("paid");
    expect(r?.phone).toBe("9812340001"); // from notes
  });

  it("Razorpay refund sample event -> refund", () => {
    const rec = adapterFor("razorpay").parse({
      event: "payment.refunded",
      payment: { id: "pay_ref", amount: 499900, currency: "INR", status: "refunded" },
      notes: { phone: "9812340001", email: "a@b.com" },
    })[0];
    expect(rec?.type).toBe("refund");
    expect(rec?.status).toBe("refunded");
  });

  it("Cashfree -> payment_success, status map + customer details", () => {
    const [r] = parseSample("cashfree");
    expect(r?.type).toBe("payment_success");
    expect(r?.gatewayTxnId).toBe("cf_txn_002");
    expect(r?.value).toBe(4999);
    expect(r?.email).toBe("priya@example.com");
    expect(r?.phone).toBe("9812340002");
  });

  it("Cosmofeed -> payment_success from order.completed", () => {
    const [r] = parseSample("cosmofeed");
    expect(r?.type).toBe("payment_success");
    expect(r?.gateway).toBe("cosmofeed");
    expect(r?.value).toBe(4999);
  });

  it("TagMango -> payment_success on order.completed; type override on order.started", () => {
    const [r] = parseSample("tagmango");
    expect(r?.type).toBe("payment_success");
    expect(r?.gatewayTxnId).toBe("tm_100");
    const started = adapterFor("tagmango").parse({
      event: "order.started",
      order: { id: "tm_100", amount: 9999, email: "s@example.com" },
    })[0];
    expect(started?.type).toBe("checkout_started"); // extractor override wins
  });

  it("FlexiFunnels -> payment_success", () => {
    const [r] = parseSample("flexifunnels");
    expect(r?.type).toBe("payment_success");
    expect(r?.value).toBe(4999);
    expect(r?.email).toBe("v@example.com");
  });

  it("Aevent -> webinar_joined with minutes_watched", () => {
    const [r] = parseSample("aevent");
    expect(r?.type).toBe("webinar_joined");
    expect(r?.minutesWatched).toBe(52);
    expect(r?.email).toBe("rakesh@example.com");
  });

  it("Zoom -> webinar_joined (match by email, spec 6)", () => {
    const [r] = parseSample("zoom");
    expect(r?.type).toBe("webinar_joined");
    expect(r?.email).toBe("sara@example.com");
  });

  it("Calendly -> call_booked, phone from the invitee question answer", () => {
    const [r] = parseSample("calendly");
    expect(r?.type).toBe("call_booked");
    expect(r?.phone).toBe("9812340008");
    expect(r?.email).toBe("rohit@example.com");
  });

  it("Pabbly -> WhatsApp inbound becomes whatsapp_replied (spec 6)", () => {
    const [r] = parseSample("pabbly");
    expect(r?.type).toBe("whatsapp_replied");
    expect(r?.phone).toBe("9812340007");
  });

  it("WhatsApp -> direction out = whatsapp_sent", () => {
    const [r] = parseSample("whatsapp");
    expect(r?.type).toBe("whatsapp_sent");
    // "919812340007" -> strip country prefix -> "9812340007"
    expect(r?.phone).toBe("9812340007");
  });

  it("Sheets -> column-mapped import rows (one inbound per row)", () => {
    const rows = parseSample("sheets");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("payment_success"); // Status: Paid
    expect(rows[0]?.value).toBe(24999);
    expect(rows[0]?.phone).toBe("98123 40009"); // raw; ingest normalises
  });

  it("xt.js -> ad_click when an ad id is present", () => {
    const [r] = parseSample("xt");
    expect(r?.type).toBe("ad_click");
    expect(r?.adId).toBe("ad_101");
    expect(r?.visitorId).toBe("v_001");
    expect(r?.fbclid).toBe("fb_abc1");
  });

  it("manual -> passthrough of any event type", () => {
    const [r] = adapterFor("manual").parse({ type: "note_added", note: "x" });
    expect(r?.type).toBe("note_added");
  });

  it("catalog exposes all 14 first-version platforms", () => {
    const platforms = adapterCatalog().map((a) => a.platform).sort();
    expect(platforms).toEqual([
      "aevent", "calendly", "cashfree", "cosmofeed", "flexifunnels",
      "manual", "meta", "pabbly", "razorpay", "sheets", "tagmango",
      "whatsapp", "xt", "zoom",
    ]);
  });
});

describe("adapters — signature verification (spec 10: verify before processing)", () => {
  it("Razorpay HMAC-SHA256 accepts a valid signature, rejects a wrong one", () => {
    const secret = "rzp_sec_test";
    const rawBody = JSON.stringify({ event: "payment.captured" });
    const sig = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    const headers = { "x-razorpay-signature": sig, rawBody };
    expect(adapterFor("razorpay").verify!({ event: "payment.captured" }, headers, secret)).toBe(true);
    expect(adapterFor("razorpay").verify!({ event: "payment.captured" }, { "x-razorpay-signature": "deadbeef", rawBody }, secret)).toBe(false);
  });

  it("Razorpay with no secret (dev mode) passes unsigned", () => {
    expect(adapterFor("razorpay").verify!({}, {}, null)).toBe(true);
  });

  it("shared-secret platforms verify the x-webhook-secret header", () => {
    const secret = "whsec_fit_000";
    const ok = { "x-webhook-secret": secret };
    expect(adapterFor("aevent").verify!({}, ok, secret)).toBe(true);
    expect(adapterFor("aevent").verify!({}, { "x-webhook-secret": "wrong" }, secret)).toBe(false);
  });
});
