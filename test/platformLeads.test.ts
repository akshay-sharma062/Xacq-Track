import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { freshDb, TestDb } from "./helpers";
import { PrismaClient } from "@prisma/client";
import {
  platformLeadsReport,
  PLATFORM_SPECS,
  PlatformLeadRow,
} from "../src/lib/platformLeads";
import { flexiLeadsReport } from "../src/lib/flexiLeads";
import { Session, maskPhone } from "../src/lib/session";

/**
 * D-23 — the shared platform-leads builder (src/lib/platformLeads.ts). The
 * per-platform field specs + the SHARED ad-account attribution / filter /
 * KPI. Read-only over spec-4 data (WebhookLog.rawPayload, Lead, Touchpoint,
 * Ad/AdSet/AdAccount); asserts the ticket's required cases:
 *
 *   - tagmango: order.completed → identity from order.*, value = order.amount,
 *     txn = order.id, kind payment_success; order.refunded → refund;
 *     order.started → checkout (kind "other" — NOT a payment).
 *   - lovable: a flat registration payload → identity + UTMs extracted,
 *     kind registered (never a payment).
 *   - flexi: unchanged — the existing flexiLeads tests (test/flexiLeads.test.ts)
 *     still pass through the thin wrapper (this file re-checks one flexi
 *     receipt through the shared builder for the shared-attribution parity).
 *   - ad-account filter: a receipt whose UTM ad-set id matches a pulled AdSet
 *     is kept for that account and excluded for another; unmatched receipts
 *     are excluded when filtered, counted in the KPI when unfiltered.
 *   - unparseable rawPayload → an honest row (parsedPayload null, kind
 *     "other"), no crash.
 *   - maskPhone applied per session on all three (identity + lead + PII-
 *     looking custom answers).
 */
let db: TestDb;
const prisma = (): PrismaClient => db.prisma;
const sessionOf = (mask: boolean): Session =>
  ({ userId: "u", workspaceId: "w", email: "a@b.c", name: "T", role: "owner", clientIds: [], maskPhone: mask }) as unknown as Session;

// One AdAccount (A) + a UTM-hit-able ad tree under it, and a second account
// (B) so the filter has a distinct "other" target. Mirrors the flexiLeads
// fixture.
const A = { set: "23001", ad: "23002" };
const OTHER_ACCT = "act_other_23";

async function fixture() {
  const p = prisma();
  const cl = await p.client.findFirst();
  if (!cl) throw new Error("bootstrap client missing");
  const clid = cl.id;

  const a1 = await p.adAccount.upsert({
    where: { metaId: "act_a_23" },
    update: { clientId: clid },
    create: { metaId: "act_a_23", clientId: clid, name: "Account A", currency: "INR" },
  });
  const a2 = await p.adAccount.create({
    data: { metaId: OTHER_ACCT, clientId: clid, name: "Account B", currency: "INR" },
  });
  // AdSet.campaignMetaId is an FK to AdCampaign.metaId — create the campaign first.
  await p.adCampaign.create({ data: { metaId: "23_cam", adAccountId: a1.id, clientId: clid, name: "c", status: "ACTIVE" } });
  await p.adSet.create({ data: { metaId: A.set, adAccountId: a1.id, campaignMetaId: "23_cam", clientId: clid, name: "s", status: "ACTIVE" } });
  await p.ad.create({ data: { metaId: A.ad, adAccountId: a1.id, adSetMetaId: A.set, clientId: clid, name: "d", status: "ACTIVE" } });

  const mkLead = async (id: string, phone: string, email: string, name: string) =>
    p.lead.create({
      data: { id, clientId: clid, phone, phoneNormalized: phone, email, emailNormalized: email, name, stage: "Registered" },
    });
  const mkReceipt = async (
    id: string,
    platform: string,
    raw: string,
    leadId?: string,
    eventType = "registered",
  ) => {
    const log = await p.webhookLog.create({
      data: { id, clientId: clid, platform, rawPayload: raw, status: "processed" },
    });
    if (leadId) {
      await p.event.create({
        data: { leadId, clientId: clid, type: eventType, sourcePlatform: platform, rawPayload: raw, webhookLogId: log.id },
      });
    }
    return log;
  };

  const now = new Date();

  // --- TagMango (the NESTED shape).
  const tml1 = await mkLead("23_tm_l1", "+919810000001", "tm1@x.com", "Tag Lead 1");
  await mkReceipt(
    "23_tm_r1", "tagmango",
    JSON.stringify({ event: "order.completed", order: { id: "tm_100", amount: 9999, product: "Masterclass", email: "tm1@x.com", phone: "+919810000001" } }),
    tml1.id, "payment_success",
  );
  const tml2 = await mkLead("23_tm_l2", "+919810000002", "tm2@x.com", "Tag Lead 2");
  await mkReceipt(
    "23_tm_r2", "tagmango",
    JSON.stringify({ event: "order.refunded", order: { id: "tm_200", amount: 499, email: "tm2@x.com", phone: "+919810000002" } }),
    tml2.id, "refund",
  );
  await mkReceipt(
    "23_tm_r3", "tagmango",
    JSON.stringify({ event: "order.started", order: { id: "tm_300", amount: 1999, email: "tm3@x.com" } }),
  );
  // Unparseable body (TagMango) — shown honestly, no crash.
  await mkReceipt("23_tm_bad", "tagmango", "not json {");

  // --- Lovable (the FLAT registration shape).
  const lvol1 = await mkLead("23_lv_l1", "+919810000009", "lv1@x.com", "Lovable Guy");
  await mkReceipt(
    "23_lv_r1", "lovable",
    JSON.stringify({
      name: "Lovable Guy", email: "lv1@x.com", phone: "+919810000009", city: "Mumbai",
      course: "Python", support_phone: "+919810000099", referral_email: "friend@x.com",
      utm_source: "facebook", utm_medium: "paid", utm_campaign: "lc1",
      utm_term: A.set, fbclid: "FBCLID_LV1", event: "form_submit",
    }),
    lvol1.id, "registered",
  );
  // No UTM, no lead → organic.
  await mkReceipt(
    "23_lv_r2", "lovable",
    JSON.stringify({ name: "Anon Lovable", phone: "+919810000010", event: "form_submit" }),
  );

  // --- One FlexiFunnels receipt (shared-attribution parity, flexi spec).
  const fxl1 = await mkLead("23_fx_l1", "+919810000020", "fx1@x.com", "Flexi Lead 1");
  await mkReceipt(
    "23_fx_r1", "flexifunnels",
    JSON.stringify({ event: "optin", first_name: "Flexi Lead 1", phone: "+919810000020", email: "fx1@x.com", "what's_your_current_it": "Data Analyst", utm_source: "facebook", utm_medium: "ads", utm_term: A.set, utm_id: A.ad }),
    fxl1.id, "registered",
  );

  return { clid, a1: a1.id, a2: a2.id };
}

beforeEach(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

// ---------------------------------------------------------------------------
// TagMango (nested) — the ticket's required kinds / value / txn / identity.
// ---------------------------------------------------------------------------
describe("platformLeadsReport — tagmango (the nested shape)", () => {
  it("order.completed → identity from order.*, value = order.amount, txn = order.id, kind payment_success", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "tagmango", clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "23_tm_r1")!;
    expect(r1.eventKind).toBe("payment_success");
    expect(r1.eventName).toBe("order.completed");
    expect(r1.identity.email).toBe("tm1@x.com");
    expect(r1.identity.phone).toBe("+919810000001");
    expect(r1.value).toBe(9999);
    expect(r1.txnId).toBe("tm_100");
    // The product (an order.* field not identity/value/txn) surfaces as a chip.
    expect(r1.custom).toMatchObject({ product: "Masterclass" });
    // TagMango payloads carry no UTM → unmatched.
    expect(r1.attribution).toBe("unmatched");
  });

  it("order.refunded → kind refund", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "tagmango", clientIds: [clid], session: sessionOf(false) });
    const r2 = rep.rows.find((r) => r.logId === "23_tm_r2")!;
    expect(r2.eventKind).toBe("refund");
    expect(r2.value).toBe(499);
    expect(r2.txnId).toBe("tm_200");
  });

  it("order.started → checkout, NOT a payment (kind 'other')", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "tagmango", clientIds: [clid], session: sessionOf(false) });
    const r3 = rep.rows.find((r) => r.logId === "23_tm_r3")!;
    expect(r3.eventKind).toBe("other");
    expect(r3.eventName).toBe("order.started");
  });
});

// ---------------------------------------------------------------------------
// Lovable (flat registration) — identity + UTM extraction, kind registered.
// ---------------------------------------------------------------------------
describe("platformLeadsReport — lovable (the flat registration shape)", () => {
  it("a flat registration payload → identity + UTMs extracted, kind registered (never a payment)", async () => {
    const { clid, a1 } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "23_lv_r1")!;
    expect(r1.eventKind).toBe("registered");
    expect(r1.identity.name).toBe("Lovable Guy");
    expect(r1.identity.city).toBe("Mumbai");
    expect(r1.utm.source).toBe("facebook");
    expect(r1.utm.medium).toBe("paid");
    expect(r1.utm.campaign).toBe("lc1");
    expect(r1.fbclid).toBe("FBCLID_LV1");
    // A Lovable form POST is a registration, NEVER a payment:
    expect(r1.value).toBeNull();
    expect(r1.txnId).toBeNull();
    // The user-named custom fields surface as chips (page-context excluded).
    expect(r1.custom).toMatchObject({ course: "Python" });
    // UTM ad-set id matches the pulled AdSet → attributed to account A ('utm').
    expect(r1.attribution).toBe("utm");
    expect(r1.adAccount?.id).toBe(a1);
  });

  it("no UTM + no lead → organic ('unmatched')", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], session: sessionOf(false) });
    const r2 = rep.rows.find((r) => r.logId === "23_lv_r2")!;
    expect(r2.attribution).toBe("unmatched");
    expect(r2.lead).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ad-account filter (SHARED logic, platform-independent — proven on the
// lovable + flexi receipts, which carry the UTM ad-set / ad ids).
// ---------------------------------------------------------------------------
describe("platformLeadsReport — the ad-account filter (shared)", () => {
  it("keeps only receipts attributed to the selected account; unmatched drop; the KPI counts unmatched only when unfiltered", async () => {
    const { clid, a1, a2 } = await fixture();

    // Unfiltered: every lovable receipt is counted; the organic ones counted.
    const all = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], session: sessionOf(false) });
    expect(all.rows.map((r) => r.logId).sort()).toEqual(["23_lv_r1", "23_lv_r2"]);
    expect(all.unmatched).toBe(1); // 23_lv_r2 is organic

    // Filtered to A: only the UTM-hit receipt (23_lv_r1) is kept.
    const keptA = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], adAccountId: a1, session: sessionOf(false) });
    expect(keptA.rows.map((r) => r.logId)).toEqual(["23_lv_r1"]);
    expect(keptA.unmatched).toBe(0); // filtered view hides the organic count

    // The SAME receipt is excluded for the other account.
    const keptB = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], adAccountId: a2, session: sessionOf(false) });
    expect(keptB.rows).toHaveLength(0);
    expect(keptB.totalReceipts).toBe(2); // receipts exist, none match B
  });

  it("a flexi receipt with the same UTM ad-set id resolves the same way (shared-attribution parity)", async () => {
    const { clid, a1 } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "flexifunnels", clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "23_fx_r1")!;
    expect(r1.attribution).toBe("utm");
    expect(r1.adAccount?.id).toBe(a1);
    expect(r1.eventName).toBe("optin");
    expect(r1.eventKind).toBe("registered"); // optin is a lead capture
  });
});

// ---------------------------------------------------------------------------
// Unparseable bodies — an honest row, no crash (every platform).
// ---------------------------------------------------------------------------
describe("platformLeadsReport — unparseable rawPayload", () => {
  it("a bad body → an honest 'unparseable' row (parsedPayload null, kind 'other', no crash)", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "tagmango", clientIds: [clid], session: sessionOf(false) });
    const bad = rep.rows.find((r) => r.logId === "23_tm_bad")!;
    expect(bad.parsedPayload).toBeNull();
    expect(bad.rawPayload).toBe("not json {");
    expect(bad.eventKind).toBe("other");
    expect(bad.attribution).toBe("unmatched");
    expect(bad.lead).toBeNull();
    // And the KPI still counts it as an organic receipt.
    expect(rep.rows.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// PII masking (spec 5.10) — identity + lead + PII-looking custom answers,
// on every platform when the role masks phones.
// ---------------------------------------------------------------------------
describe("platformLeadsReport — maskPhone per session", () => {
  it("masks the payload phone + the lead phone + PII-looking custom answers for a maskPhone session", async () => {
    const { clid } = await fixture();
    const masked = sessionOf(true);

    // Lovable: identity.phone + lead.phone masked; the user-named custom
    // answers that look like a phone / email are masked too (never a raw PII
    // leak through a "form answer").
    const lv = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], session: masked });
    const r1 = lv.rows.find((r) => r.logId === "23_lv_r1")!;
    expect(r1.identity.phone).toBe(maskPhone("+919810000009", masked));
    expect(r1.identity.phone.endsWith("0009")).toBe(true);
    expect(r1.identity.phone).not.toContain("+91");
    expect(r1.lead!.phone).toBe(maskPhone("+919810000009", masked));
    expect(String(r1.custom.support_phone)).toMatch(/^•/); // phone-looking custom masked
    expect(String(r1.custom.referral_email)).toContain("•••"); // email-looking custom masked
    expect(r1.custom.course).toBe("Python"); // non-PII answer shown as-captured

    // TagMango: the order.* phone + the lead phone masked.
    const tm = await platformLeadsReport(prisma(), { platform: "tagmango", clientIds: [clid], session: masked });
    const t1 = tm.rows.find((r) => r.logId === "23_tm_r1")!;
    expect(t1.identity.phone).toBe(maskPhone("+919810000001", masked));
    expect(t1.lead!.phone).toBe(maskPhone("+919810000001", masked));

    // FlexiFunnels: the flat phone masked (the wrapper path).
    const fx = await platformLeadsReport(prisma(), { platform: "flexifunnels", clientIds: [clid], session: masked });
    const f1 = fx.rows.find((r) => r.logId === "23_fx_r1")!;
    expect(f1.identity.phone).toBe(maskPhone("+919810000020", masked));
  });

  it("an unmasked role (owner/admin) sees the phones as-captured", async () => {
    const { clid } = await fixture();
    const lv = await platformLeadsReport(prisma(), { platform: "lovable", clientIds: [clid], session: sessionOf(false) });
    const r1 = lv.rows.find((r) => r.logId === "23_lv_r1")!;
    expect(r1.identity.phone).toBe("+919810000009"); // as-captured
    expect(r1.custom.support_phone).toBe("+919810000099"); // as-captured
  });
});

// ---------------------------------------------------------------------------
// The thin flexi wrapper still works (the ticket: flexi is unchanged).
// ---------------------------------------------------------------------------
describe("flexiLeadsReport — the thin wrapper (no regression)", () => {
  it("resolves the flexi receipts through the shared builder exactly as before", async () => {
    const { clid, a1 } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "23_fx_r1")!;
    expect(r1.attribution).toBe("utm");
    expect(r1.adAccount?.id).toBe(a1);
    expect(r1.eventName).toBe("optin");
    expect(r1.utm.term).toBe(A.set);
    expect(r1.utm.id).toBe(A.ad);
    expect(r1.custom).toMatchObject({ "what's_your_current_it": "Data Analyst" });
  });
});

// ---------------------------------------------------------------------------
// The spec table is complete (all 4 platforms ship a spec).
// ---------------------------------------------------------------------------
describe("PLATFORM_SPECS — all 4 platforms ship a field spec", () => {
  it("flexifunnels + lovable + tagmango + cashfree each have identity + eventKind + (value/txn where applicable)", () => {
    expect(Object.keys(PLATFORM_SPECS).sort()).toEqual(["cashfree", "flexifunnels", "lovable", "tagmango"]);
    for (const spec of Object.values(PLATFORM_SPECS)) {
      expect(typeof spec.identityFromPayload).toBe("function");
      expect(typeof spec.eventKindFromPayload).toBe("function");
    }
    // The nested platform carries value + txn; the flat lead-capture ones
    // do not (lovable = registered, never a payment).
    expect(typeof PLATFORM_SPECS.tagmango.valueFromPayload).toBe("function");
    expect(typeof PLATFORM_SPECS.tagmango.txnIdFromPayload).toBe("function");
    expect(PLATFORM_SPECS.lovable.valueFromPayload!({})).toBeNull();
    // D-24b: cashfree is the UTM-inheriting payment platform (task 1 step 2).
    expect(PLATFORM_SPECS.cashfree.inheritLeadUtm).toBe(true);
    expect(typeof PLATFORM_SPECS.cashfree.valueFromPayload).toBe("function");
  });
});
