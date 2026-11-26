import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { freshDb, TestDb } from "./helpers";
import { PrismaClient } from "@prisma/client";
import { platformLeadsReport } from "../src/lib/platformLeads";
import { Session } from "../src/lib/session";

/**
 * D-24b — CashFree cross-platform attribution: a CashFree receipt whose lead
 * came from Lovable (or any UTM-carrying platform) inherits that lead's UTM +
 * ad account from the matched lead's Touchpoints — not just its own payload.
 *
 * The ticket's required cases:
 *   1. A CashFree receipt that matched a lead with a UTM Touchpoint → the
 *      row shows the Touchpoint's UTM + ad account + utmOrigin = "lead".
 *   2. A CashFree receipt with notes.utm_source set (the PO's task-5 spec —
 *      notes is a JSON string) → UTM from notes, utmOrigin = "notes"
 *      (notes wins over the lead's touchpoint).
 *   3. A CashFree receipt with no notes AND no matched lead → UTM empty,
 *      ad account "unmatched", no utmOrigin (honest "—", not faked).
 *   4. Cross-consistency: the inherited UTM's ad-set id resolves to the SAME
 *      AdAccount as the lead's original ad-click touchpoint's ad account
 *      (the "utm" path hit, before the "meta_touchpoint" fallback).
 *   5. The /cashfree-leads empty-state note renders the 3-cause checklist
 *      (source contract, the D-22/D-12 precedent — client-side empty-state
 *      wording is asserted on the view source, not hermetically rendered).
 */
let db: TestDb;
const prisma = (): PrismaClient => db.prisma;
const sessionOf = (): Session =>
  ({ userId: "u", workspaceId: "w", email: "a@b.c", name: "T", role: "owner", clientIds: [], maskPhone: false }) as unknown as Session;

// One AdAccount + a UTM-hit-able ad tree under it (mirrors the D-23 fixture).
const A = { set: "24b_set_24", ad: "24b_ad_24" };
const PAST = new Date("2026-11-01T00:00:00Z"); // the lead's touchpoint, well before the receipt

// --- The G4-era CashFree receipt shape (camelCase under data) — what the 18
//     live receipts on disk look like. No notes.
const cfNoNotes = (phone: string) =>
  JSON.stringify({
    data: {
      transactionId: `cf_txn_${phone}`, orderId: `o_cf_${phone}`, amount: 4999, currency: "INR", status: "PAID",
      customerEmail: `p${phone}@x.com`, customerDetails: { phone, name: "Payer" }, description: "Webinar pass",
    },
    eventId: `evt_cf_${phone}`, eventDate: "2026-11-10T14:00:00+05:30",
  });
// --- The task-5 PO spec: notes is a JSON *string* (the checkout JSON.stringify's it).
const cfWithNotes = (phone: string) =>
  JSON.stringify({
    data: {
      transactionId: `cf_txn_${phone}_n`, orderId: `o_cf_${phone}_n`, amount: 2499, currency: "INR", status: "PAID",
      customerEmail: `p${phone}@x.com`, customerDetails: { phone, name: "Payer" }, description: "Webinar pass",
    },
    notes: JSON.stringify({
      utm_source: "cf_notes_source", utm_medium: "cf_notes_medium", utm_campaign: "cf_notes_campaign",
      utm_term: "24b_notes_term", phone, email: `p${phone}@x.com`, name: "Payer",
    }),
    eventId: `evt_cf_${phone}_n`, eventDate: "2026-11-10T14:00:00+05:30",
  });
// --- The REAL CashFree payment-webhook shape (snake_case nested under
//     data.payment / data.order / data.customer_details) — the D-24b spec
//     reads it defensively; a success receipt.
const cfRealShape = () =>
  JSON.stringify({
    type: "PAYMENT_SUCCESS_WEBHOOK",
    event_time: "2026-11-10T14:00:00+05:30",
    data: {
      order: { order_id: "order_24b_real", order_amount: 9999, order_currency: "INR", order_note: "Webinar pass" },
      payment: { cf_payment_id: "1453995084705707520", payment_status: "SUCCESS", payment_amount: 9999, payment_currency: "INR" },
      customer_details: { customer_name: "Real Shape Payer", customer_email: "real@x.com", customer_phone: "+919810000109" },
    },
  });

async function fixture() {
  const p = prisma();
  const cl = await p.client.findFirst();
  if (!cl) throw new Error("bootstrap client missing");
  const clid = cl.id;

  const a1 = await p.adAccount.upsert({
    where: { metaId: "act_a_24b" },
    update: { clientId: clid },
    create: { metaId: "act_a_24b", clientId: clid, name: "Account A", currency: "INR" },
  });
  await p.adCampaign.create({ data: { metaId: "24b_cam", adAccountId: a1.id, clientId: clid, name: "c", status: "ACTIVE" } });
  await p.adSet.create({ data: { metaId: A.set, adAccountId: a1.id, campaignMetaId: "24b_cam", clientId: clid, name: "s", status: "ACTIVE" } });
  await p.ad.create({ data: { metaId: A.ad, adAccountId: a1.id, adSetMetaId: A.set, clientId: clid, name: "d", status: "ACTIVE" } });

  const mkLead = async (id: string, phone: string, email: string, name: string) =>
    p.lead.create({
      data: { id, clientId: clid, phone, phoneNormalized: phone, email, emailNormalized: email, name, stage: "Registered" },
    });
  const mkReceipt = async (id: string, raw: string, leadId?: string, eventType = "payment_success") => {
    const log = await p.webhookLog.create({
      data: { id, clientId: clid, platform: "cashfree", rawPayload: raw, status: "processed" },
    });
    if (leadId) {
      await p.event.create({
        data: { leadId, clientId: clid, type: eventType, sourcePlatform: "cashfree", rawPayload: raw, webhookLogId: log.id },
      });
    }
    return log;
  };

  // --- Lead 1: a Lovable-sourced lead whose form submission is on file as a
  //     UTM-carrying Touchpoint (utm_term = A.set) + an ad-click touchpoint
  //     (adRefId = A.ad) under the SAME account (the cross-consistency pair).
  const l1 = await mkLead("24b_l1", "+919810000101", "24b_l1@x.com", "Lovable Payer");
  await p.touchpoint.create({
    data: {
      id: "24b_tp_l1", leadId: l1.id, clientId: clid, timestamp: PAST,
      utmSource: "facebook", utmMedium: "paid", utmCampaign: "24b_campaign", utmTerm: A.set,
      adRefId: A.ad, kind: "ad_click",
    },
  });
  // The CashFree receipt that matched this lead (by phone) — no notes:
  // inheritance must fill the UTM + ad account from the touchpoint.
  await mkReceipt("24b_cf_r1", cfNoNotes("+919810000101"), l1.id);

  // --- Lead 2: a UTM-carrying touchpoint, but the receipt carries its OWN
  //     notes UTM → the notes must win over the lead's touchpoint.
  const l2 = await mkLead("24b_l2", "+919810000102", "24b_l2@x.com", "Notes Payer");
  await p.touchpoint.create({
    data: {
      id: "24b_tp_l2", leadId: l2.id, clientId: clid, timestamp: PAST,
      utmSource: "ig", utmTerm: A.set, kind: "form_submit",
    },
  });
  await mkReceipt("24b_cf_r2", cfWithNotes("+919810000102"), l2.id);

  // --- Case 3: no notes + no matched lead → the honest "—" row.
  await mkReceipt("24b_cf_r3", cfNoNotes("+919810000103"));

  // --- The real nested CashFree shape (no UTM, no lead — also the honest "—").
  await mkReceipt("24b_cf_real", cfRealShape());

  return { clid, a1: a1.id };
}

beforeEach(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

describe("D-24b — a CashFree receipt inherits the matched lead's Touchpoint UTM + ad account", () => {
  it("case 1+4: a no-notes receipt matched to a Lovable lead → the lead's Touchpoint UTM + the SAME ad account as the lead's ad-click touchpoint (utmOrigin = 'lead')", async () => {
    const { clid, a1 } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "cashfree", clientIds: [clid], session: sessionOf() });
    const r1 = rep.rows.find((r) => r.logId === "24b_cf_r1")!;

    // The UTM inherited from the lead's Touchpoint (task 1 step 2):
    expect(r1.utmOrigin).toBe("lead");
    expect(r1.utm.source).toBe("facebook");
    expect(r1.utm.medium).toBe("paid");
    expect(r1.utm.campaign).toBe("24b_campaign");
    expect(r1.utm.term).toBe(A.set);

    // Cross-consistency (task 2): the inherited UTM's ad-set id resolved to
    // an ad account through the SHARED UTM match — and it is the SAME account
    // the lead's original ad-click touchpoint (adRefId = A.ad) belongs to.
    const origAd = await prisma().ad.findUnique({ where: { metaId: A.ad } });
    expect(origAd?.adAccountId).toBe(a1); // the lead's ad-click account
    expect(r1.attribution).toBe("utm"); // the INHERITED UTM hit path 1 (not the meta_touchpoint fallback)
    expect(r1.adAccount?.id).toBe(a1); // …to the SAME account
  });

  it("case 2: notes UTM wins over the lead's touchpoint (utmOrigin = 'notes')", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "cashfree", clientIds: [clid], session: sessionOf() });
    const r2 = rep.rows.find((r) => r.logId === "24b_cf_r2")!;

    // The payload's own notes (a JSON string, the task-5 PO spec) — NOT the
    // lead's ig/utm_term=A.set touchpoint:
    expect(r2.utmOrigin).toBe("notes");
    expect(r2.utm.source).toBe("cf_notes_source");
    expect(r2.utm.term).toBe("24b_notes_term"); // the notes term, not A.set
    // The notes term matches no pulled ad → the ad account stays unmatched
    // (the notes UTM is not the lead's ad-set id — honest, not a guess):
    expect(r2.attribution).toBe("unmatched");
    expect(r2.adAccount).toBeNull();
  });

  it("case 3: no notes + no matched lead → UTM empty, ad account unmatched, no utmOrigin (honest '—', never faked)", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "cashfree", clientIds: [clid], session: sessionOf() });
    const r3 = rep.rows.find((r) => r.logId === "24b_cf_r3")!;
    expect(r3.utmOrigin).toBeUndefined(); // no source indicator — genuinely none
    expect(Object.keys(r3.utm).length).toBe(0);
    expect(r3.attribution).toBe("unmatched");
    expect(r3.adAccount).toBeNull();
    expect(r3.lead).toBeNull();
  });

  it("the real nested CashFree payload shape parses (identity + value + txn + kind) without UTM", async () => {
    const { clid } = await fixture();
    const rep = await platformLeadsReport(prisma(), { platform: "cashfree", clientIds: [clid], session: sessionOf() });
    const rr = rep.rows.find((r) => r.logId === "24b_cf_real")!;
    expect(rr.identity.name).toBe("Real Shape Payer");
    expect(rr.identity.phone).toBe("+919810000109");
    expect(rr.eventKind).toBe("payment_success"); // PAYMENT_SUCCESS_WEBHOOK
    expect(rr.value).toBe(9999); // rupees, not paise
    expect(rr.txnId).toBe("1453995084705707520"); // cf_payment_id
    expect(rr.utmOrigin).toBeUndefined(); // no UTM anywhere → honest
    expect(rr.attribution).toBe("unmatched");
  });
});

describe("D-24b — the /cashfree-leads empty-state 3-cause note (source contract)", () => {
  it("the cashfree empty state renders the 3-cause checklist, gated to the cashfree platform only", () => {
    const view = readFileSync("src/app/components/PlatformLeadsView.tsx", "utf8");
    // The ticket's exact one-line note (the 3 causes the PO checks):
    expect(view).toContain("No CashFree receipts yet. Check: (1) CashFree dashboard");
    expect(view).toContain("webhook signing secret matches CASHFREE_WEBHOOK_SECRET");
    expect(view).toContain("(3) a live payment has been made.");
    // Gated to cashfree ONLY (the other platforms keep their plain empty state):
    expect(view).toContain('showNoReceiptsChecklist = platform === "cashfree"');
    // The UTM source indicator (task 3) is also cashfree-only:
    expect(view).toContain('showUtmOrigin={platform === "cashfree"}');
    // The indicator's three states: "notes" / "lead" / "—":
    expect(view).toContain('UTM inherited from lead');
    expect(view).toContain("UTM from notes");
    expect(view).toContain("UTM: {utmSourceLabel}");
  });
});
