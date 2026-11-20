import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { freshDb, TestDb } from "./helpers";
import { PrismaClient } from "@prisma/client";
import { flexiLeadsReport } from "../src/lib/flexiLeads";
import { Session, maskPhone } from "../src/lib/session";

/**
 * The "Flexi Leads" report builder (src/lib/flexiLeads.ts). It is read-only over
 * spec-4 data (WebhookLog.rawPayload = the exact body; Event.rawPayload.meta =
 * D-19 custom fields; Lead/Touchpoint = ingested identity + attribution) and
 * resolves each FlexiFunnels receipt to a Meta ad account by:
 *   1. UTM — the receipt's utm_term/utm_id (Meta ad / ad-set ids) matching a
 *      pulled AdSet/Ad/AdCampaign under the account;
 *   2. the lead's own Meta ad-click touchpoint (adRefId → Ad → AdAccount);
 *   3. else "unmatched" (organic) — never guessed.
 */
let db: TestDb;
const prisma = (): PrismaClient => db.prisma;
const sessionOf = (mask: boolean): Session =>
  ({ userId: "u", workspaceId: "w", email: "a@b.c", name: "T", role: "owner", clientIds: [], maskPhone: mask }) as unknown as Session;

// One AdAccount + a campaign/adsset/ad tree the UTM match can hit.
const A = { cam: "fx_fl_cam", set: "120250090382550032", ad: "120250090382550001" };
const OTHER_ACCT = "act_other";

async function fixture() {
  const p = prisma();
  const cl = await p.client.findFirst();
  if (!cl) throw new Error("bootstrap client missing");
  const clid = cl.id;

  // Account A (the bootstrap G1 account) + a UTM-hit-able ad tree under it.
  const a1 = await p.adAccount.upsert({
    where: { metaId: "act_a" },
    update: { clientId: clid },
    create: { metaId: "act_a", clientId: clid, name: "Account A", currency: "INR" },
  });
  // Account B (a second account, so the filter has a distinct target).
  const a2 = await p.adAccount.create({
    data: { metaId: OTHER_ACCT, clientId: clid, name: "Account B", currency: "INR" },
  });
  await p.adCampaign.create({ data: { metaId: A.cam, adAccountId: a1.id, clientId: clid, name: "c", status: "ACTIVE" } });
  await p.adSet.create({ data: { metaId: A.set, adAccountId: a1.id, campaignMetaId: A.cam, clientId: clid, name: "s", status: "ACTIVE" } });
  await p.ad.create({ data: { metaId: A.ad, adAccountId: a1.id, adSetMetaId: A.set, clientId: clid, name: "d", status: "ACTIVE" } });

  const mkLead = async (id: string, phone: string, email: string) =>
    p.lead.create({
      data: { id, clientId: clid, phone, phoneNormalized: phone, email, emailNormalized: email, name: "Lead " + id, stage: "Registered" },
    });
  const mkReceipt = async (id: string, raw: string, leadId?: string, eventType = "registered", receivedAt?: Date) => {
    const log = await p.webhookLog.create({
      data: { id, clientId: clid, platform: "flexifunnels", rawPayload: raw, status: "processed", ...(receivedAt ? { receivedAt } : {}) },
    });
    if (leadId) {
      await p.event.create({
        data: { leadId, clientId: clid, type: eventType, sourcePlatform: "flexifunnels", rawPayload: raw, webhookLogId: log.id },
      });
    }
    return log;
  };

  const now = new Date();
  // R1 — UTM hit: utm_term = the pulled AdSet id → "utm", Account A.
  const L1 = await mkLead("fx_l1", "+919811110001", "one@x.com");
  await mkReceipt("fx_r1", JSON.stringify({ event: "optin", first_name: "One", phone: "+919811110001", email: "one@x.com", "what's_your_current_it": "Data Analyst", utm_source: "facebook", utm_medium: "ads", utm_term: A.set, utm_id: A.ad, datetime: "17/11/2026, 10:53:56 am" }), L1.id, "registered", now);
  // R2 — UTM miss (unknown id) + lead has a Meta ad-click touchpoint → "meta_touchpoint", Account A.
  const L2 = await mkLead("fx_l2", "+919811110002", "two@x.com");
  await mkReceipt("fx_r2", JSON.stringify({ event: "optin", phone: "+919811110002", email: "two@x.com", city: "Delhi", utm_term: "not_a_pulled_id", fbclid: "FBCLID_2" }), L2.id, "registered", now);
  await p.touchpoint.create({ data: { id: "fx_tp2", leadId: L2.id, clientId: clid, kind: "ad_click", adId: A.ad, adRefId: A.ad, timestamp: now } });
  // R3 — no UTM match, no ad touchpoint → "unmatched" (organic).
  const L3 = await mkLead("fx_l3", "+919811110003", "three@x.com");
  await mkReceipt("fx_r3", JSON.stringify({ event: "optin", phone: "+919811110003", email: "three@x.com" }), L3.id, "registered", now);
  // R4 — unparseable body (still shown, honestly).
  await mkReceipt("fx_r4", "this is { not json", undefined, "registered", now);

  return { clid, a1: a1.id, a2: a2.id, L1: L1.id, L2: L2.id, L3: L3.id };
}

beforeEach(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db?.close();
});

describe("flexiLeadsReport — ad-account attribution (the chosen contract)", () => {
  it("attributes a receipt to an account via its UTM ad-set id ('utm')", async () => {
    const { clid, a1 } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "fx_r1")!;
    expect(r1.attribution).toBe("utm");
    expect(r1.adAccount?.id).toBe(a1);
    // The UTM ad-set / ad ids surface on the row.
    expect(r1.utm.term).toBe(A.set);
    expect(r1.utm.id).toBe(A.ad);
  });

  it("falls back to the lead's Meta ad-click touchpoint when UTM misses ('meta_touchpoint')", async () => {
    const { clid, a1 } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r2 = rep.rows.find((r) => r.logId === "fx_r2")!;
    expect(r2.attribution).toBe("meta_touchpoint");
    expect(r2.adAccount?.id).toBe(a1);
    expect(r2.fbclid).toBe("FBCLID_2");
  });

  it("marks a receipt with no UTM match and no ad touchpoint as 'unmatched' (organic)", async () => {
    const { clid } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r3 = rep.rows.find((r) => r.logId === "fx_r3")!;
    expect(r3.attribution).toBe("unmatched");
    expect(r3.adAccount).toBeNull();
    // Unfiltered KPI counts every organic receipt: R3 (no UTM / no ad touchpoint)
    // + R4 (unparseable, no lead) = 2.
    expect(rep.unmatched).toBe(2);
  });
});

describe("flexiLeadsReport — the ad-account filter", () => {
  it("keeps only receipts attributed to the selected account; unmatched drop", async () => {
    const { clid, a1, a2 } = await fixture();
    const kept = await flexiLeadsReport(prisma(), { clientIds: [clid], adAccountId: a1, session: sessionOf(false) });
    const ids = kept.rows.map((r) => r.logId).sort();
    // R1 (utm) + R2 (meta_touchpoint) both resolve to account A; R3/R4 don't.
    expect(ids).toEqual(["fx_r1", "fx_r2"]);
    expect(kept.unmatched).toBe(0); // filtered view hides the organic count
    expect(kept.uniqueLeads).toBe(2);
  });

  it("an account with no flexi receipts yields an empty (but honest) table", async () => {
    const { clid, a2 } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], adAccountId: a2, session: sessionOf(false) });
    expect(rep.rows).toHaveLength(0);
    expect(rep.totalReceipts).toBeGreaterThan(0); // receipts exist, none match this account
  });
});

describe("flexiLeadsReport — payload shaping (spec 4: show everything, formatted)", () => {
  it("surfaces custom form answers + UTM extras + identity, phone unmasked for owner", async () => {
    const { clid } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r1 = rep.rows.find((r) => r.logId === "fx_r1")!;
    expect(r1.custom).toEqual({ "what's_your_current_it": "Data Analyst" });
    expect(r1.identity.phone).toBe("+919811110001"); // unmasked (owner)
    expect(r1.parsedPayload).not.toBeNull();
    expect(r1.eventName).toBe("optin");
  });

  it("masks the phone for a maskPhone session", async () => {
    const { clid } = await fixture();
    const masked = sessionOf(true);
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: masked });
    const r1 = rep.rows.find((r) => r.logId === "fx_r1")!;
    // The exact mask string comes from the app's own maskPhone (spec 5.10
    // last-4), not a hand-counted bullet literal.
    expect(r1.identity.phone).toBe(maskPhone("+919811110001", masked));
    expect(r1.identity.phone.endsWith("0001")).toBe(true);
    expect(r1.identity.phone).not.toContain("+91");
  });

  it("shows an unparseable body honestly (no crash, no invented payload)", async () => {
    const { clid } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    const r4 = rep.rows.find((r) => r.logId === "fx_r4")!;
    expect(r4.parsedPayload).toBeNull();
    expect(r4.rawPayload).toBe("this is { not json");
    expect(r4.attribution).toBe("unmatched");
    expect(r4.lead).toBeNull();
  });

  it("reports totalReceipts + last24h over the whole client set", async () => {
    const { clid } = await fixture();
    const rep = await flexiLeadsReport(prisma(), { clientIds: [clid], session: sessionOf(false) });
    expect(rep.totalReceipts).toBe(4);
    expect(rep.last24h).toBe(4); // all fixture receipts are 'now'
    expect(rep.lastReceivedAt).not.toBeNull();
  });
});
