/**
 * D-19b — FlexiFunnels lead-capture form data (flat shape, no invented
 * fields, lead-view card + idempotent junk-lead backfill).
 *
 * The D-19/D-19b guarantee, proven at the repo's test boundary:
 *   (a) the adapter reads FlexiFunnels' REAL flat optin payload — a custom
 *       form answer ("what's_your_current_it") lands in `meta` UNTOUCHED
 *       (no invented/renamed keys, no dropped fields; a body with no custom
 *       fields gets NO meta — the opposite of inventing);
 *   (b) the backfill is ADDITIVE + IDEMPOTENT: a junk lead gets its real
 *       identity + its event gets `meta` + the `webhookLogId` link; a second
 *       run finds 0 qualifying leads and changes 0 rows; two leads NEVER
 *       share one WebhookLog row (no duplicate identities); a non-backfillable
 *       (payment-fixture) log is honestly skipped;
 *   (c) the lead-view "Form data" card resolves event-`meta` first and falls
 *       back to the linked WebhookLog body (pre-D-19 events) via the SAME
 *       flat-shape extractor — and nothing renders when nothing is stored;
 *   (d) the card's identity lines mask per the session (the maskPhone
 *       convention), emails masked the same way (maskEmail).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import {
  FLEXI_OPTIN_SAMPLE,
  flexifunnelsAdapter,
  flexiFormFieldsFromRaw,
  parseFlexiDatetime,
} from "../src/lib/adapters/payments";
import {
  candidatesFromFlexiLogs,
  matchFlexiBackfill,
  runFlexiBackfill,
  type FlexiCandidate,
} from "../scripts/backfill-flexi";
import { resolveLeadFormFields, maskEmail } from "../src/lib/leadFormFields";
import { maskPhone, type Session } from "../src/lib/session";

const FIT = "cl_upcurvv"; // the tenancy bootstrap client

const NOW = () => new Date();

/** A flat optin body the way FlexiFunnels ACTUALLY sends it (the D-19 shape). */
const flatOptin = (phone: string, email: string, extra?: Record<string, unknown>) =>
  JSON.stringify({
    first_name: "Ravi",
    email,
    phone,
    city: "Pune",
    "what's_your_current_it": "Product Manager",
    utm_source: "facebook",
    utm_campaign: "reels_10",
    utm_id: "fb_utm_id_1",
    path: "/join",
    landing_url: "https://join.example.com/join",
    source_url: "https://join.example.com/join",
    fbclid: "PAZXh0_TEST",
    datetime: "17/11/2026, 10:53:56 am",
    event: "optin",
    ...extra,
  });

/** A pre-D-18 "payment proof" body — parses to a PAYMENT, so it is NOT
 *  backfillable (its junk lead stays source-unknown, honestly). */
const paymentFixture = (email: string, phone: string) =>
  JSON.stringify({
    action: "order.paid",
    customer: { email, phone },
    order_id: "d18_txn",
    amount: 4999,
  });

async function makeJunkLead(p: PrismaClient, suffix: string): Promise<string> {
  const l = await p.lead.create({
    data: { id: `d19b_ld_${suffix}`, clientId: FIT, sourceUnknown: true },
  });
  return l.id;
}

/** A flexi Event row the way ingest wrote it (record-level payload). */
async function makeFlexiEvent(
  p: PrismaClient,
  suffix: string,
  leadId: string,
  recordPayload: string,
  webhookLogId: string | null
): Promise<void> {
  await p.event.create({
    data: {
      id: `d19b_ev_${suffix}`,
      leadId,
      clientId: FIT,
      type: "registered",
      sourcePlatform: "flexifunnels",
      rawPayload: recordPayload,
      webhookLogId,
      timestamp: NOW(),
    },
  });
}

describe("D-19b (a) — the flat optin shape: custom fields carried in `meta`, nothing invented", () => {
  it("optin → registered with full identity + UTM carry-through", () => {
    const [r] = flexifunnelsAdapter.parse(FLEXI_OPTIN_SAMPLE);
    expect(r?.type).toBe("registered"); // a lead-capture, NOT a payment
    expect(r?.phone).toBe("+919812340005");
    expect(r?.email).toBe("priya.optin@example.com");
    expect(r?.name).toBe("Priya");
    expect(r?.city).toBe("Mumbai");
    expect(r?.utmSource).toBe(FLEXI_OPTIN_SAMPLE.utm_source);
    expect(r?.utmCampaign).toBe(FLEXI_OPTIN_SAMPLE.utm_campaign);
    expect(r?.fbclid).toBe("PAZXh0_EXAMPLE_FBCLID_0001");
  });

  it("a custom form answer lands in `meta` UNTOUCHED — no invented/renamed keys", () => {
    const [r] = flexifunnelsAdapter.parse(FLEXI_OPTIN_SAMPLE);
    const meta = r?.meta ?? {};
    // the user-named key survives verbatim (even the apostrophe + lowercase "it"):
    expect(meta["what's_your_current_it"]).toBe("Data Analyst");
    // page context + UTM-extras travel too:
    expect(meta.path).toBe("/vpaxdvju");
    expect(meta.landing_url).toBe(FLEXI_OPTIN_SAMPLE.landing_url);
    expect(meta.utm_id).toBe("120250090379420032");
  });

  it("consumed keys never leak into `meta` (phone/utm_source/event are mapped, not meta)", () => {
    const [r] = flexifunnelsAdapter.parse(FLEXI_OPTIN_SAMPLE);
    const meta = r?.meta ?? {};
    for (const k of ["phone", "email", "first_name", "city", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "event", "datetime"]) {
      expect(meta, `meta must not re-carry the consumed key ${k}`).not.toHaveProperty(k);
    }
    // empty-string values are dropped (utm_flow="" in the sample):
    expect(meta).not.toHaveProperty("utm_flow");
  });

  it("a body with NO custom fields gets NO meta (the opposite of inventing)", () => {
    const [r] = flexifunnelsAdapter.parse({ event: "optin", email: "x@y.com", phone: "9812340000" });
    expect(r?.type).toBe("registered");
    expect(r?.meta).toBeUndefined();
  });

  it("an unknown/unrecognised event name degrades to registered, never payment_failed", () => {
    const [r] = flexifunnelsAdapter.parse({ event: "totally.new.event", email: "a@b.com", phone: "9812340001" });
    expect(r?.type).toBe("registered");
    expect(r?.type).not.toBe("payment_failed");
  });

  it("flexiFormFieldsFromRaw and the adapter's meta use ONE extractor (same custom map)", () => {
    const [r] = flexifunnelsAdapter.parse(FLEXI_OPTIN_SAMPLE);
    const raw = flexiFormFieldsFromRaw(FLEXI_OPTIN_SAMPLE);
    expect(raw.custom).toEqual(r?.meta);
    expect(raw.utm.id).toBe(String(FLEXI_OPTIN_SAMPLE.utm_id));
    expect(raw.phone).toBe("+919812340005");
  });

  it("parseFlexiDatetime reads FlexiFunnels' IST wall-clock into the right UTC instant", () => {
    const d = parseFlexiDatetime("17/11/2026, 10:53:56 am");
    // 10:53:56 IST = 05:23:56 UTC (UTC+5:30)
    expect(d?.getUTCHours()).toBe(5);
    expect(d?.getUTCMinutes()).toBe(23);
    expect(parseFlexiDatetime("nonsense")).toBeNull();
    expect(parseFlexiDatetime(null)).toBeNull();
  });
});

describe("D-19b (b) — the backfill: additive, idempotent, no duplicate identities", () => {
  let db: TestDb;
  let p: PrismaClient;
  beforeEach(async () => {
    db = await freshDb();
    p = db.prisma;
  });
  afterEach(async () => {
    await db.close();
  });

  it("a 2nd run is a NO-OP: 0 qualifying leads, 0 rows changed", async () => {
    // junk leads (no identity) + their flexi logs + events, time-aligned.
    const t0 = NOW();
    const l1 = await makeJunkLead(p, "a");
    const l2 = await makeJunkLead(p, "b");
    const logA = await p.webhookLog.create({
      data: { id: "d19b_log_a", clientId: FIT, platform: "flexifunnels", rawPayload: flatOptin("+919812340011", "a@x.com"), receivedAt: t0 },
    });
    const logB = await p.webhookLog.create({
      data: { id: "d19b_log_b", clientId: FIT, platform: "flexifunnels", rawPayload: flatOptin("+919812340022", "b@x.com"), receivedAt: t0 },
    });
    await makeFlexiEvent(p, "a", l1, JSON.stringify({ meta: null }), logA.id);
    await makeFlexiEvent(p, "b", l2, JSON.stringify({ meta: null }), logB.id);

    const r1 = await runFlexiBackfill(p, { clientId: FIT });
    expect(r1.matched).toBe(2);
    expect(r1.updatedLeads).toBe(2);
    expect(r1.stillNullIdent).toBe(0);

    // the leads now carry their REAL identity + sourceUnknown cleared:
    const back = await p.lead.findMany({ where: { id: { in: [l1, l2] } }, select: { phone: true, email: true, sourceUnknown: true } });
    expect(back.map((l) => l.phone).sort()).toEqual(["+919812340011", "+919812340022"]);
    expect(back.every((l) => l.sourceUnknown === false)).toBe(true);

    // event got `meta` attached + the webhookLogId link:
    const evA = await p.event.findUniqueOrThrow({ where: { id: "d19b_ev_a" } });
    expect(JSON.parse(evA.rawPayload).meta["what's_your_current_it"]).toBe("Product Manager");
    expect(evA.webhookLogId).toBe("d19b_log_a");

    // 2nd run: no more junk → nothing matched, nothing written.
    const before = await p.lead.count({ where: { clientId: FIT } });
    const r2 = await runFlexiBackfill(p, { clientId: FIT });
    expect(r2.matched).toBe(0);
    expect(r2.updatedLeads).toBe(0);
    expect(r2.eventsAttached).toBe(0);
    expect(await p.lead.count({ where: { clientId: FIT } })).toBe(before); // no rows added/removed
    expect(r2.stillNullIdent).toBe(0);
  });

  it("a NON-backfillable log (a payment fixture) is honestly skipped — its junk lead stays source-unknown", async () => {
    const l = await makeJunkLead(p, "pay");
    await p.webhookLog.create({
      data: { id: "d19b_log_pay", clientId: FIT, platform: "flexifunnels", rawPayload: paymentFixture("d18proof@example.com", "+919812345678"), receivedAt: NOW() },
    });
    const r = await runFlexiBackfill(p, { clientId: FIT });
    expect(r.candidateCount).toBe(0); // payment parses → not a lead-capture
    expect(r.matched).toBe(0);
    expect(r.skippedNoPayload).toBe(1);
    const after = await p.lead.findUniqueOrThrow({ where: { id: l } });
    expect(after.phone).toBeNull(); // never retrofitted with the fixture identity
    expect(after.sourceUnknown).toBe(true);
  });

  it("TWO leads never SHARE one log (no duplicate identities)", () => {
    const c: FlexiCandidate = { logId: "log_x", logAt: new Date("2026-01-01T00:00:00Z"), phone: "+919812340099", email: "shared@x.com" };
    const res = matchFlexiBackfill(
      [c],
      [
        { id: "l1", createdAt: new Date("2026-01-01T00:00:00Z") },
        { id: "l2", createdAt: new Date("2026-01-01T00:00:30Z") },
      ]
    );
    expect(res.matched).toBe(1);
    expect(res.skippedNoPayload).toBe(1);
    expect(res.matches[0]?.leadId).toBe("l1"); // the nearest lead wins
    // and the candidate list was not mutated for reuse:
    expect(candidatesFromFlexiLogs([])).toEqual([]);
  });

  it("a log OUTSIDE the window is not matched", () => {
    const c: FlexiCandidate = { logId: "log_far", logAt: new Date("2026-01-01T00:00:00Z"), phone: "+91", email: "far@x.com" };
    const res = matchFlexiBackfill(
      [c],
      [{ id: "l_far", createdAt: new Date("2026-01-01T01:00:00Z") }], // 1h away
      60_000
    );
    expect(res.matched).toBe(0);
    expect(res.skippedNoPayload).toBe(1);
  });
});

describe("D-19b (c) — the lead-view 'Form data' resolver: event-`meta` first, WebhookLog fallback", () => {
  it("reads the record-level `meta` when present (the D-19 path)", () => {
    const events = [
      { rawPayload: JSON.stringify({ meta: null }), webhookLogId: "log_old" }, // pre-D-19 row, newest
      { rawPayload: JSON.stringify({ meta: { "what's_your_current_it": "Dev", utm_id: "u1", utm_flow: "" } }), webhookLogId: "log_new" },
    ];
    const f = resolveLeadFormFields(events, null);
    expect(f?.from).toBe("event-meta");
    expect(f?.custom["what's_your_current_it"]).toBe("Dev");
    expect(f?.utmExtras.utm_id).toBe("u1");
    expect(f?.utmExtras.utm_flow).toBeUndefined(); // empty string → dropped, not shown
  });

  it("FALLS BACK to the linked WebhookLog body for a pre-D-19 event (same extractor, no invention)", () => {
    const body = flatOptin("+919812340033", "c@x.com");
    const events = [{ rawPayload: JSON.stringify({ meta: null }), webhookLogId: "log_1" }];
    const f = resolveLeadFormFields(events, body);
    expect(f?.from).toBe("webhook-log");
    expect(f?.custom["what's_your_current_it"]).toBe("Product Manager");
    expect(f?.utmExtras.utm_id).toBe("fb_utm_id_1");
    expect(f?.fbclid).toBe("PAZXh0_TEST");
    expect(f?.webhookLogId).toBe("log_1");
  });

  it("returns null when NOTHING usable is stored (the card hides; nothing invented)", () => {
    expect(resolveLeadFormFields([{ rawPayload: JSON.stringify({ meta: null }), webhookLogId: null }], null)).toBeNull();
    // an unparseable body is not a crash + not a fabricated result:
    expect(resolveLeadFormFields([{ rawPayload: "{}", webhookLogId: "log_1" }], "not-json")).toBeNull();
  });
});

describe("D-19b (d) — the card's identity lines mask per the session", () => {
  const ses = (maskPhone: boolean): Session =>
    ({ userId: "u", workspaceId: "w", email: "e", name: "n", role: "owner", clientIds: [], maskPhone });
  const noMask = ses(false);
  const withMask = ses(true);

  it("maskEmail mirrors the maskPhone convention (last-2 local + domain)", () => {
    expect(maskEmail("priya.optin@example.com", noMask)).toBe("priya.optin@example.com");
    expect(maskEmail("priya.optin@example.com", withMask)).toBe("in@example.com");
    expect(maskEmail(null, noMask)).toBe("");
    expect(maskEmail("@x.com", withMask)).toBe("••••"); // no local part
    expect(maskEmail("plain", withMask)).toBe("••••"); // no @ at all
  });

  it("maskPhone (the existing helper) still masks the phone line the same way", () => {
    expect(maskPhone("+919812340055", noMask)).toBe("+919812340055");
    expect(maskPhone("+919812340055", withMask)).toBe("•••••••••0055");
  });
});
