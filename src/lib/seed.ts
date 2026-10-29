/**
 * Demo seed (fake data ONLY — spec rule 8).
 *
 * Builds a rich, fully cross-linked fixture set so every one of the 14 screens
 * and every report shows real numbers on a fresh `pnpm db:seed`/`seed:local`.
 * Two workspaces, three clients, a dozen+ leads across the whole journey
 * (registered -> attended -> hot -> call booked -> paid), plus a refund, a
 * "source unknown" payment, and a duplicate candidate. Ad entities, a 30-day
 * spend series, timeline events, webhook logs, CAPI outbound events and audit
 * rows round it out.
 *
 * This file is the framework-free "data" half of the seed. The Prisma-writing
 * half is `prisma/seed.ts`. All ids are explicit and readable so fixtures are
 * easy to cross-reference.
 */
import { hashEmailForCapi, hashPhoneForCapi } from "./hash";
import type { PrismaClient } from "./prisma";

// The demo's "today". The seed spreads events backwards from this moment so
// the last-30-day reports (the default range) actually show numbers. Anchor is
// the real now — NOT 30 days in the past — otherwise every "daysAgo(base, N)"
// row lands 30+N days ago and falls outside the default 30-day window.
export const ANCHOR_NOW = (): Date => new Date();

const iso = (ms: number) => new Date(ms).toISOString();
function daysAgo(base: Date, days: number, hour = 10): string {
  const d = new Date(base);
  d.setDate(d.getDate() - days);
  d.setHours(hour, 15, 0, 0);
  return iso(d.getTime());
}
function daysAhead(base: Date, days: number, hour = 11): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 30, 0, 0);
  return iso(d.getTime());
}

export interface SeedBundle {
  base: Date;
  workspaces: any[];
  users: any[];
  clients: any[];
  funnels: any[];
  adAccounts: any[];
  adCampaigns: any[];
  adSets: any[];
  ads: any[];
  creatives: any[];
  visitors: any[];
  leads: any[];
  touchpoints: any[];
  events: any[];
  payments: any[];
  tasks: any[];
  notes: any[];
  calls: any[];
  webhooks: any[];
  outbound: any[];
  audit: any[];
  metaForms: any[];
  fieldMappings: any[];
  attributionRules: any[];
  reportConfigs: any[];
  spends: any[];
}

export function buildSeed(): SeedBundle {
  const base = ANCHOR_NOW();
  // Stable readable ids.
  const W1 = "ws_agency"; // Foremost Leads (our agency)
  const W2 = "ws_trial"; // a trial SaaS customer (multi-tenant proof)

  const U = {
    owner: "u_owner",
    admin: "u_admin",
    buyer: "u_media_buyer",
    rep: "u_sales_rep",
    rep2: "u_sales_rep_2",
    viewer: "u_viewer",
    client: "u_client_login",
  };
  const C = { fit: "cl_fitness", iit: "cl_iitprep", saas: "cl_trial_saas" };

  // --- Ad entities (client: fitness) -------------------------------------
  const ACO = "aa_123"; // ad account (Meta number)
  const AC = "cam_launch";
  const AS = "aset_1";
  const AD1 = "ad_101"; // video ad, does well
  const AD2 = "ad_102"; // static ad, wasted spend
  const AD3 = "ad_103"; // retargeting, converts

  const offers = [
    { p: 4999, label: "Webinar pass" },
    { p: 24999, label: "Mentorship cohort" },
    { p: 99999, label: "Full program" },
  ];

  // --- Lead journeys -------------------------------------------------------
  // A set of coherent leads. phone stored as E.164 + normalised twin.
  const mkLead = (o: any) => o;

  const leads = [
    // Full happy journey: ad -> registered -> attended -> hot -> call -> paid.
    mkLead({
      id: "ld_001", clientId: C.fit, funnelId: "fn_wb1",
      phone: "+919812340001", phoneNormalized: "+919812340001",
      email: "rakesh@example.com", emailNormalized: "rakesh@example.com",
      name: "Rakesh Kumar", city: "Pune",
      stage: "Paid", ownerId: U.rep,
      visitorId: "v_001",
      createdAt: daysAgo(base, 22),
    }),
    // Refund journey.
    mkLead({
      id: "ld_002", clientId: C.fit, funnelId: "fn_wb1",
      phone: "+919812340002", phoneNormalized: "+919812340002",
      email: "priya@example.com", emailNormalized: "priya@example.com",
      name: "Priya Nair", city: "Bengaluru",
      stage: "Lost", ownerId: U.rep2,
      visitorId: "v_002",
      createdAt: daysAgo(base, 20),
    }),
    // Source-unknown payment: a gateway txn with no matching lead (spec 6).
    mkLead({
      id: "ld_003", clientId: C.fit,
      sourceUnknown: true,
      phone: null, phoneNormalized: null,
      email: "walkin@example.com", emailNormalized: "walkin@example.com",
      name: "Walk-in (source unknown)", city: null,
      stage: "Paid", ownerId: U.rep,
      createdAt: daysAgo(base, 6),
    }),
    // Duplicate candidate: same email as ld_004, different phone (spec 5.3).
    mkLead({
      id: "ld_004", clientId: C.fit,
      phone: "+919812340004", phoneNormalized: "+919812340004",
      email: "anil@example.com", emailNormalized: "anil@example.com",
      name: "Anil (typo phone)", city: "Mumbai",
      stage: "Hot", isDuplicateCandidate: true, ownerId: U.rep,
      createdAt: daysAgo(base, 12),
    }),
    mkLead({
      id: "ld_005", clientId: C.fit,
      phone: "+919812340005", phoneNormalized: "+919812340005",
      email: "anil@example.com", emailNormalized: "anil@example.com",
      name: "Anil (correct)", city: "Mumbai",
      stage: "Call Booked", ownerId: U.rep, isDuplicateCandidate: true,
      createdAt: daysAgo(base, 12),
    }),
    // Attended, hot, call booked, paid — second payer (cohort).
    mkLead({
      id: "ld_006", clientId: C.fit, funnelId: "fn_wb1",
      phone: "+919812340006", phoneNormalized: "+919812340006",
      email: "sara@example.com", emailNormalized: "sara@example.com",
      name: "Sara Menon", city: "Hyderabad",
      stage: "Paid", ownerId: U.rep, visitorId: "v_006",
      createdAt: daysAgo(base, 18),
    }),
    // Registered but not attended.
    mkLead({
      id: "ld_007", clientId: C.fit, funnelId: "fn_wb1",
      phone: "+919812340007", phoneNormalized: "+919812340007",
      email: "vikram@example.com", emailNormalized: "vikram@example.com",
      name: "Vikram Rao", city: "Chennai",
      stage: "Registered", ownerId: U.rep, visitorId: "v_007",
      createdAt: daysAgo(base, 10),
    }),
    // Attended but no call yet — keeps the funnel's "Attended" count alive.
    mkLead({
      id: "ld_012", clientId: C.fit, funnelId: "fn_wb1",
      phone: "+919812340012", phoneNormalized: "+919812340012",
      email: "omar@example.com", emailNormalized: "omar@example.com",
      name: "Omar Sheikh", city: "Kolkata",
      stage: "Attended", ownerId: U.rep2,
      createdAt: daysAgo(base, 11),
    }),
    // IIT prep client — a new client with its own funnel + a Meta Instant Form lead.
    mkLead({
      id: "ld_008", clientId: C.iit, funnelId: "fn_call1",
      phone: "+919812340008", phoneNormalized: "+919812340008",
      email: "rohit@example.com", emailNormalized: "rohit@example.com",
      name: "Rohit Iyer", city: "Delhi",
      stage: "Call Booked", ownerId: U.rep,
      createdAt: daysAgo(base, 8),
    }),
    mkLead({
      id: "ld_009", clientId: C.iit, funnelId: "fn_call1",
      phone: "+919812340009", phoneNormalized: "+919812340009",
      email: "neha@example.com", emailNormalized: "neha@example.com",
      name: "Neha Gupta", city: "Patna",
      stage: "Paid", ownerId: U.rep,
      createdAt: daysAgo(base, 5),
    }),
    // Trial SaaS customer lead (multi-tenant proof).
    mkLead({
      id: "ld_010", clientId: C.saas,
      phone: "+919812340010", phoneNormalized: "+919812340010",
      email: "trialuser@example.com", emailNormalized: "trialuser@example.com",
      name: "Trial Customer Lead", city: "Kochi",
      stage: "Registered", ownerId: U.viewer,
      createdAt: daysAgo(base, 3),
    }),
    // Soft-deleted lead (stops future CAPI; spec 10).
    mkLead({
      id: "ld_011", clientId: C.fit,
      phone: "+919812340011", phoneNormalized: "+919812340011",
      email: "gdpr@example.com", emailNormalized: "gdpr@example.com",
      name: "Deleted Lead", city: null,
      stage: "Lost", ownerId: U.rep, deletedAt: daysAgo(base, 2),
      createdAt: daysAgo(base, 24),
    }),
  ];

  // --- Visitors (anonymous before identity) -------------------------------
  const visitors = [
    { visitorId: "v_001", clientId: C.fit, fbp: "441231", fbc: "fb.fb_abc1", firstSeen: daysAgo(base, 22), lastSeen: daysAgo(base, 21) },
    { visitorId: "v_002", clientId: C.fit, fbp: "441232", fbc: "fb.fb_abc2", firstSeen: daysAgo(base, 20), lastSeen: daysAgo(base, 19) },
    { visitorId: "v_006", clientId: C.fit, fbp: "441236", fbc: "fb.fb_abc6", firstSeen: daysAgo(base, 18), lastSeen: daysAgo(base, 17) },
    { visitorId: "v_007", clientId: C.fit, fbp: "441237", fbc: "fb.fb_abc7", firstSeen: daysAgo(base, 10), lastSeen: daysAgo(base, 10) },
  ];

  // --- Touchpoints (ad clicks / form submits) ----------------------------
  // For the happy lead, a first ad click (AD1) and a retargeting click (AD3).
  const touchpoints = [
    {
      id: "tp_001", leadId: "ld_001", visitorId: "v_001", clientId: C.fit,
      adId: AD1, adsetId: AS, campaignId: AC, adRefId: AD1,
      fbclid: "fb_abc1", fbc: "fb.fb_abc1", fbp: "441231",
      utmSource: "facebook", utmMedium: "ads", utmCampaign: "w1_launch",
      landingUrl: "/w1", kind: "ad_click",
      timestamp: daysAgo(base, 22, 9),
    },
    {
      id: "tp_002", leadId: "ld_001", visitorId: "v_001", clientId: C.fit,
      adId: AD3, adsetId: AS, campaignId: AC, adRefId: AD3,
      fbclid: "fb_abc1", fbc: "fb.fb_abc1", fbp: "441231",
      utmSource: "facebook", utmMedium: "ads", utmCampaign: "w1_retar",
      landingUrl: "/w1/replay", kind: "page_view",
      timestamp: daysAgo(base, 15, 16),
    },
    {
      id: "tp_003", leadId: "ld_001", visitorId: "v_001", clientId: C.fit,
      adId: AD1, adsetId: AS, campaignId: AC, adRefId: AD1,
      kind: "form_submit", timestamp: daysAgo(base, 21, 11),
    },
    {
      id: "tp_004", leadId: "ld_006", visitorId: "v_006", clientId: C.fit,
      adId: AD1, adsetId: AS, campaignId: AC, adRefId: AD1,
      fbclid: "fb_abc6", fbc: "fb.fb_abc6", fbp: "441236",
      kind: "ad_click", timestamp: daysAgo(base, 18, 10),
    },
    {
      id: "tp_005", leadId: "ld_002", visitorId: "v_002", clientId: C.fit,
      adId: AD1, adsetId: AS, campaignId: AC, adRefId: AD1,
      fbclid: "fb_abc2", fbc: "fb.fb_abc2", fbp: "441232",
      kind: "ad_click", timestamp: daysAgo(base, 20, 9),
    },
    {
      id: "tp_006", leadId: "ld_007", visitorId: "v_007", clientId: C.fit,
      adId: AD2, adsetId: AS, campaignId: AC, adRefId: AD2,
      fbclid: "fb_abc7", fbc: "fb.fb_abc7", fbp: "441237",
      kind: "ad_click", timestamp: daysAgo(base, 10, 12),
    },
    {
      // IIT prep — Meta Instant Form lead (ad ids returned by the lead webhook).
      id: "tp_007", leadId: "ld_008", clientId: C.iit,
      adId: "ad_iit_1", adsetId: "aset_iit_1", campaignId: "cam_iit_1", adRefId: "ad_iit_1",
      fbclid: "fb_abc8", fbc: "fb.fb_abc8", fbp: "441238",
      kind: "meta_form_lead", timestamp: daysAgo(base, 8, 13),
    },
  ];

  // Link first/last touch ids on leads that have them.
  for (const l of leads) {
    const mine = touchpoints.filter((t: any) => t.leadId === l.id);
    if (mine.length) {
      const tss = mine.map((t: any) => t.timestamp).sort();
      l.firstTouchId = tss[0];
      l.lastTouchId = tss[tss.length - 1];
    }
  }

  // --- Webhook logs (spec 5.6: every inbound logged) ----------------------
  const webhooks = [
    {
      id: "wh_001", clientId: C.fit, platform: "aevent",
      status: "processed", rawPayload: JSON.stringify({ sample: "aevent WebinarJoin" }),
      eventId: "ae_1", receivedAt: daysAgo(base, 20), processedAt: daysAgo(base, 20),
    },
    {
      id: "wh_002", clientId: C.fit, platform: "razorpay",
      status: "processed", rawPayload: JSON.stringify({ event: "payment.captured", order_id: "o_f22" }),
      eventId: "rzp_txn_001", receivedAt: daysAgo(base, 4), processedAt: daysAgo(base, 4),
    },
    {
      id: "wh_003", clientId: C.fit, platform: "zoom",
      status: "failed", rawPayload: JSON.stringify({ event: "meeting.participant_joined" }),
      error: "401 invalid api key — re-auth required", retryCount: 3,
      receivedAt: daysAgo(base, 3),
    },
    {
      id: "wh_004", clientId: C.fit, platform: "razorpay",
      status: "duplicate", rawPayload: JSON.stringify({ event: "payment.captured", order_id: "o_f22" }),
      eventId: "rzp_txn_001", receivedAt: daysAgo(base, 4), processedAt: daysAgo(base, 4),
    },
    {
      id: "wh_005", clientId: C.iit, platform: "meta",
      status: "processed", rawPayload: JSON.stringify({ object: "lead", ad_id: AD3 }),
      eventId: "meta_lead_008", receivedAt: daysAgo(base, 8), processedAt: daysAgo(base, 8),
    },
  ];

  // --- Timeline events (spec 4 union) ------------------------------------
  const events: any[] = [];
  const ev = (e: any) => events.push(e);
  // ld_001 full journey
  // NOTE: ad-carrying events embed their timestamp in the raw payload because
  // the attribution/report layer reads ad ids from the raw payload (spec 4:
  // "keep raw_payload of every incoming webhook"). Without it, attribution
  // would fall back to "now" and every credit would fall outside the window.
  ev({ id: "ev_001", leadId: "ld_001", clientId: C.fit, type: "meta_form_lead", sourcePlatform: "meta", rawPayload: JSON.stringify({ ad_id: AD1, timestamp: daysAgo(base, 22) }), timestamp: daysAgo(base, 22) });
  ev({ id: "ev_002", leadId: "ld_001", clientId: C.fit, type: "registered", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 21), webhookLogId: "wh_001" });
  ev({ id: "ev_003", leadId: "ld_001", clientId: C.fit, type: "webinar_joined", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "joined" }), timestamp: daysAgo(base, 15) });
  ev({ id: "ev_004", leadId: "ld_001", clientId: C.fit, type: "webinar_left", sourcePlatform: "aevent", value: 0, minutesWatched: 52, rawPayload: JSON.stringify({ minutes: 52 }), timestamp: daysAgo(base, 15) });
  ev({ id: "ev_005", leadId: "ld_001", clientId: C.fit, type: "call_booked", sourcePlatform: "calendly", rawPayload: JSON.stringify({ e: "call_booked" }), timestamp: daysAgo(base, 12) });
  ev({ id: "ev_006", leadId: "ld_001", clientId: C.fit, type: "checkout_started", sourcePlatform: "tagmango", rawPayload: JSON.stringify({ e: "checkout" }), timestamp: daysAgo(base, 5) });
  ev({ id: "ev_007", leadId: "ld_001", clientId: C.fit, type: "payment_success", sourcePlatform: "razorpay", value: offers[1].p, currency: "INR", rawPayload: JSON.stringify({ txn: "rzp_txn_001" }), timestamp: daysAgo(base, 4), webhookLogId: "wh_002" });
  ev({ id: "ev_008", leadId: "ld_001", clientId: C.fit, type: "stage_changed", sourcePlatform: "manual", value: 0, rawPayload: JSON.stringify({ from: "Call Booked", to: "Paid" }), timestamp: daysAgo(base, 4) });
  // ld_002 refund journey
  ev({ id: "ev_009", leadId: "ld_002", clientId: C.fit, type: "registered", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 19) });
  ev({ id: "ev_010", leadId: "ld_002", clientId: C.fit, type: "payment_success", sourcePlatform: "cashfree", value: offers[0].p, currency: "INR", rawPayload: JSON.stringify({ txn: "cf_txn_002" }), timestamp: daysAgo(base, 9) });
  ev({ id: "ev_011", leadId: "ld_002", clientId: C.fit, type: "refund", sourcePlatform: "cashfree", value: offers[0].p, currency: "INR", rawPayload: JSON.stringify({ txn: "cf_ref_002" }), timestamp: daysAgo(base, 2) });
  // ld_006 paid (cohort)
  ev({ id: "ev_012", leadId: "ld_006", clientId: C.fit, type: "registered", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 17) });
  ev({ id: "ev_013", leadId: "ld_006", clientId: C.fit, type: "webinar_joined", sourcePlatform: "aevent", minutesWatched: 80, rawPayload: JSON.stringify({ minutes: 80 }), timestamp: daysAgo(base, 14) });
  ev({ id: "ev_014", leadId: "ld_006", clientId: C.fit, type: "payment_success", sourcePlatform: "razorpay", value: offers[2].p, currency: "INR", rawPayload: JSON.stringify({ txn: "rzp_txn_006" }), timestamp: daysAgo(base, 3) });
  // ld_003 source-unknown payment
  ev({ id: "ev_015", leadId: "ld_003", clientId: C.fit, type: "payment_success", sourcePlatform: "unknown", value: offers[0].p, currency: "INR", rawPayload: JSON.stringify({ note: "walk-in, no lead match" }), timestamp: daysAgo(base, 6) });
  // ld_007 not attended
  ev({ id: "ev_016", leadId: "ld_007", clientId: C.fit, type: "registered", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 10) });
  ev({ id: "ev_017", leadId: "ld_007", clientId: C.fit, type: "whatsapp_sent", sourcePlatform: "whatsapp", rawPayload: JSON.stringify({ e: "wa" }), timestamp: daysAgo(base, 9) });
  ev({ id: "ev_018", leadId: "ld_007", clientId: C.fit, type: "whatsapp_replied", sourcePlatform: "whatsapp", rawPayload: JSON.stringify({ e: "wa_reply" }), timestamp: daysAgo(base, 8) });
  // ld_008 / ld_009 IIT prep
  ev({ id: "ev_019", leadId: "ld_008", clientId: C.iit, type: "meta_form_lead", sourcePlatform: "meta", rawPayload: JSON.stringify({ ad_id: AD3 }), timestamp: daysAgo(base, 8), webhookLogId: "wh_005" });
  ev({ id: "ev_020", leadId: "ld_008", clientId: C.iit, type: "call_booked", sourcePlatform: "calendly", rawPayload: JSON.stringify({ e: "call_booked" }), timestamp: daysAgo(base, 6) });
  ev({ id: "ev_021", leadId: "ld_009", clientId: C.iit, type: "payment_success", sourcePlatform: "razorpay", value: offers[1].p, currency: "INR", rawPayload: JSON.stringify({ txn: "rzp_txn_009" }), timestamp: daysAgo(base, 3) });
  // ld_010 trial
  ev({ id: "ev_022", leadId: "ld_010", clientId: C.saas, type: "registered", sourcePlatform: "flexifunnels", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 3) });
  // ld_006 (cohort payer) — ad carry-through on form fill (AD1, in-window for last-click).
  ev({ id: "ev_023", leadId: "ld_006", clientId: C.fit, type: "form_submit", sourcePlatform: "aevent", rawPayload: JSON.stringify({ ad_id: AD1, timestamp: daysAgo(base, 17) }), timestamp: daysAgo(base, 17) });
  // ld_009 (IIT payer) — Meta Instant Form lead on the IIT ad.
  ev({ id: "ev_024", leadId: "ld_009", clientId: C.iit, type: "meta_form_lead", sourcePlatform: "meta", rawPayload: JSON.stringify({ ad_id: "ad_iit_1", adset_id: "aset_iit_1", campaign_id: "cam_iit_1", timestamp: daysAgo(base, 6) }), timestamp: daysAgo(base, 6) });
  // ld_012 (attended, not booked) — webinar journey with an ad click.
  ev({ id: "ev_025", leadId: "ld_012", clientId: C.fit, type: "registered", sourcePlatform: "aevent", rawPayload: JSON.stringify({ e: "registered" }), timestamp: daysAgo(base, 11) });
  ev({ id: "ev_026", leadId: "ld_012", clientId: C.fit, type: "webinar_joined", sourcePlatform: "aevent", minutesWatched: 65, rawPayload: JSON.stringify({ ad_id: AD3, timestamp: daysAgo(base, 11) }), timestamp: daysAgo(base, 10) });

  // --- Payments ----------------------------------------------------------
  const payments = [
    { id: "pay_001", leadId: "ld_001", clientId: C.fit, product: "Mentorship cohort", amount: offers[1].p, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_txn_001", status: "paid", paidAt: daysAgo(base, 4) },
    { id: "pay_002", leadId: "ld_002", clientId: C.fit, product: "Webinar pass", amount: offers[0].p, currency: "INR", gateway: "cashfree", gatewayTxnId: "cf_txn_002", status: "refunded", paidAt: daysAgo(base, 9), refundedAt: daysAgo(base, 2), refundEventId: "ev_011" },
    { id: "pay_003", leadId: "ld_006", clientId: C.fit, product: "Full program", amount: offers[2].p, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_txn_006", status: "paid", paidAt: daysAgo(base, 3) },
    { id: "pay_004", leadId: "ld_003", clientId: C.fit, product: "Webinar pass", amount: offers[0].p, currency: "INR", gateway: "unknown", gatewayTxnId: "walkin_000", status: "paid", paidAt: daysAgo(base, 6) },
    { id: "pay_005", leadId: "ld_009", clientId: C.iit, product: "Mentorship cohort", amount: offers[1].p, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_txn_009", status: "paid", paidAt: daysAgo(base, 3) },
    // A failed payment (still logged; not revenue).
    { id: "pay_006", leadId: "ld_007", clientId: C.fit, product: "Webinar pass", amount: offers[0].p, currency: "INR", gateway: "razorpay", gatewayTxnId: "rzp_fail_007", status: "failed", paidAt: null },
  ];

  // --- Tasks / Notes / Calls --------------------------------------------
  const tasks = [
    { id: "tsk_001", leadId: "ld_005", userId: U.rep, type: "call", dueAt: daysAhead(base, 1, 14), outcome: null, notes: "Follow up on cohort seat", createdAt: daysAgo(base, 1) },
    { id: "tsk_002", leadId: "ld_008", userId: U.rep, type: "whatsapp", dueAt: daysAhead(base, 0, 18), outcome: null, notes: "Send syllabus PDF", createdAt: daysAgo(base, 0) },
  ];
  const notes = [
    { id: "nt_001", leadId: "ld_001", userId: U.rep, body: "Committed to cohort after the live Q&A.", createdAt: daysAgo(base, 4) },
    { id: "nt_002", leadId: "ld_002", userId: U.rep2, body: "Refund processed — did not show up to two sessions.", createdAt: daysAgo(base, 2) },
  ];
  const calls = [
    { id: "call_001", leadId: "ld_001", userId: U.rep, bookedAt: daysAgo(base, 12), doneAt: daysAgo(base, 12), outcome: "won", notes: "Pain point: weight plateaus." },
    { id: "call_002", leadId: "ld_008", userId: U.rep, bookedAt: daysAhead(base, 1), doneAt: null, outcome: null, notes: "Call tomorrow 6pm IST." },
  ];

  // --- CAPI outbound events (spec 5.8) ----------------------------------
  const leadPhone: Record<string, string> = {
    ld_001: "+919812340001", ld_006: "+919812340006", ld_002: "+919812340002",
  };
  const leadEmail: Record<string, string> = {
    ld_001: "rakesh@example.com", ld_006: "sara@example.com", ld_002: "priya@example.com",
  };
  const capiBase = (o: any) => ({
    id: o.id,
    clientId: C.fit,
    leadId: o.leadId,
    type: o.type,
    value: o.value ?? null,
    currency: "INR",
    fbc: "fb.fb_abc1",
    fbp: "441231",
    hashedPhone: leadPhone[o.leadId] ? hashPhoneForCapi(leadPhone[o.leadId]!) : hashPhoneForCapi("unknown"),
    hashedEmail: leadEmail[o.leadId] ? hashEmailForCapi(leadEmail[o.leadId]!) : null,
    clientIp: "203.0.113.10",
    userAgent: "Mozilla/5.0 (Linux) XacqoraDemo",
    eventTime: o.eventTime,
    eventId: o.id + "_eid",
    dedupKey: o.dedupKey,
    sentToMeta: o.sent ?? false,
    status: o.status ?? "queued",
    matchQuality: o.mq ?? null,
    createdAt: o.eventTime,
    sentAt: o.sent ? o.eventTime : null,
  });
  const outbound = [
    capiBase({ id: "oe_001", leadId: "ld_001", type: "Lead", eventTime: daysAgo(base, 22), sent: true, status: "sent", mq: 9 }),
    capiBase({ id: "oe_002", leadId: "ld_001", type: "CompleteRegistration", eventTime: daysAgo(base, 21), sent: true, status: "sent", mq: 9 }),
    capiBase({ id: "oe_003", leadId: "ld_001", type: "Attended", eventTime: daysAgo(base, 15), sent: true, status: "sent", mq: 8 }),
    capiBase({ id: "oe_004", leadId: "ld_001", type: "Schedule", eventTime: daysAgo(base, 12), sent: true, status: "sent", mq: 8 }),
    capiBase({ id: "oe_005", leadId: "ld_001", type: "Purchase", value: offers[1].p, eventTime: daysAgo(base, 4), sent: true, status: "sent", mq: 10 }),
    // A queued purchase for ld_006 (retry pending).
    capiBase({ id: "oe_006", leadId: "ld_006", type: "Purchase", value: offers[2].p, eventTime: daysAgo(base, 3), sent: false, status: "queued", mq: null }),
    // Refunded -> skipped (spec 5.8: never send Purchase for a refund).
    {
      ...capiBase({ id: "oe_007", leadId: "ld_002", type: "Refund", value: offers[0].p, eventTime: daysAgo(base, 2), sent: false, status: "skipped", mq: null }),
      dedupKey: "Refund:cl_fitness:walkin_unknown:cf_ref_002",
    },
    // A failed send (retry needed).
    {
      ...capiBase({ id: "oe_008", leadId: "ld_001", type: "Lead", eventTime: daysAgo(base, 22, 23) }),
      dedupKey: "Lead:cl_fitness:rakesh@example.com:dup_replay",
      status: "failed",
      error: "400 — access token expired; re-auth",
      sentToMeta: false,
    },
  ];

  // --- Audit log ---------------------------------------------------------
  const audit = [
    { id: "al_001", clientId: C.fit, userId: U.owner, action: "login", entity: "user", entityId: U.owner, details: JSON.stringify({ ip: "10.0.0.1" }), at: daysAgo(base, 30) },
    { id: "al_002", clientId: C.fit, userId: U.admin, action: "export", entity: "leads", entityId: C.fit, details: JSON.stringify({ rows: 12, filter: "stage=Paid" }), at: daysAgo(base, 5) },
    { id: "al_003", clientId: C.fit, userId: U.admin, action: "stage_change", entity: "lead", entityId: "ld_001", details: JSON.stringify({ from: "Call Booked", to: "Paid" }), at: daysAgo(base, 4) },
    { id: "al_004", clientId: C.fit, userId: U.rep, action: "view", entity: "lead", entityId: "ld_002", details: JSON.stringify({ phoneMasked: true }), at: daysAgo(base, 2) },
    { id: "al_005", clientId: C.fit, userId: U.owner, action: "merge", entity: "lead", entityId: "ld_005", details: JSON.stringify({ into: "ld_005", from: "ld_004" }), at: daysAgo(base, 1) },
  ];

  // --- Meta lead form + field mapping (spec 5.2) ------------------------
  const metaForms = [
    {
      id: "mf_001", clientId: C.iit, formId: "form_iit_001", name: "IIT Prep — Webinar Instant Form",
      subscribed: true, pageId: "page_iit",
      fieldsMapping: JSON.stringify({ "What is your name?": "name", "Phone number": "phone", "Email": "email", "City": "city" }),
    },
  ];
  const fieldMappings = [
    { id: "fm_001", metaLeadFormId: "mf_001", questionId: "q_name", mapsTo: "name", customKey: null },
    { id: "fm_002", metaLeadFormId: "mf_001", questionId: "q_phone", mapsTo: "phone", customKey: null },
    { id: "fm_003", metaLeadFormId: "mf_001", questionId: "q_email", mapsTo: "email", customKey: null },
    { id: "fm_004", metaLeadFormId: "mf_001", questionId: "q_city", mapsTo: "city", customKey: null },
  ];

  // --- Attribution + report config (spec 7) -----------------------------
  const attributionRules = [
    { id: "ar_001", clientId: C.fit, model: "last_paid_click", windowDays: 30, scope: "report", createdAt: daysAgo(base, 30) },
    { id: "ar_002", clientId: C.fit, model: "first_click", windowDays: 60, scope: "report", createdAt: daysAgo(base, 30) },
  ];
  const reportConfigs = [
    { id: "rc_001", clientId: C.fit, key: "funnel", value: JSON.stringify({ costPerSaleThreshold: 4000 }), createdAt: daysAgo(base, 30) },
    { id: "rc_002", clientId: C.fit, key: "wasted_spend", value: JSON.stringify({ minSpend: 2000, maxZeroSales: 3 }), createdAt: daysAgo(base, 30) },
    { id: "rc_003", clientId: C.fit, key: "weekly", value: JSON.stringify({ sendPdf: true, at: "09:00 IST Monday" }), createdAt: daysAgo(base, 30) },
  ];

  // --- Spend (30-day daily series per ad, spec 5.7) ---------------------
  // Ad1 (video) is high-spend and converting; Ad2 (static) is high-spend with
  // ZERO sales -> wasted spend; Ad3 (retargeting) is cheap and converts.
  const FX = 84; // USD -> INR demo rate
  const spends: any[] = [];
  const profiles: Record<string, { spend: number; clicks: number; conv: number; thruplay: number }> = {
    [AD1]: { spend: 900, clicks: 650, conv: 3, thruplay: 220 },
    [AD2]: { spend: 500, clicks: 220, conv: 0, thruplay: 80 },
    [AD3]: { spend: 150, clicks: 90, conv: 2, thruplay: 30 },
  };
  const pushFitnessSpend = (d: number, dayStr: string, adMetaId: string, p: { spend: number; clicks: number; conv: number; thruplay: number }) => {
    // Slight day-to-day wobble so the charts aren't perfectly flat.
    const wobble = 0.8 + (0.4 * ((d * 7 + adMetaId.charCodeAt(4)) % 10) / 10);
    const spend = Math.round(p.spend * wobble * 100) / 100;
    spends.push({
      id: `sp_${adMetaId}_${d}`,
      adMetaId,
      adAccountId: ACO,
      clientId: C.fit,
      day: dayStr,
      spend,
      impressions: Math.round(p.clicks * 18 * wobble),
      reach: Math.round(p.clicks * 9 * wobble),
      clicks: Math.round(p.clicks * wobble),
      linkClicks: Math.round(p.clicks * 0.7 * wobble),
      thruPlays: Math.round(p.thruplay * wobble),
      currency: "USD",
      inrRate: FX,
      inrSpend: Math.round(spend * FX * 100) / 100,
      // Meta-reported conversions (spec 7 "Meta vs Xacqora Track"): Meta
      // over-reports slightly vs what our records counted.
      metaConversions: d % 7 === 0 ? p.conv + 1 : p.conv,
    });
  };

  // IIT prep ad — smaller, cheaper, but converts. Own ad account + client.
  const IIT_ACO = "aa_222";
  const IIT_AD = "ad_iit_1";
  const IIT_PROFILE = { spend: 60, clicks: 140, conv: 2, thruplay: 0 };
  const pushIitSpend = (d: number, dayStr: string) => {
    const p = IIT_PROFILE;
    const wobble = 0.8 + (0.4 * ((d * 3 + 5) % 10) / 10);
    const spend = Math.round(p.spend * wobble * 100) / 100;
    spends.push({
      id: `sp_${IIT_AD}_${d}`,
      adMetaId: IIT_AD,
      adAccountId: IIT_ACO,
      clientId: C.iit,
      day: dayStr,
      spend,
      impressions: Math.round(p.clicks * 16 * wobble),
      reach: Math.round(p.clicks * 8 * wobble),
      clicks: Math.round(p.clicks * wobble),
      linkClicks: Math.round(p.clicks * 0.7 * wobble),
      thruPlays: 0,
      currency: "USD",
      inrRate: FX,
      inrSpend: Math.round(spend * FX * 100) / 100,
      metaConversions: d % 5 === 0 ? p.conv : 0,
    });
  };

  for (let d = 29; d >= 0; d--) {
    const dayStr = (() => { const dt = new Date(base); dt.setDate(dt.getDate() - d); return dt.toISOString().slice(0, 10); })();
    for (const adMetaId of [AD1, AD2, AD3]) pushFitnessSpend(d, dayStr, adMetaId, profiles[adMetaId]);
    pushIitSpend(d, dayStr);
  }

  return {
    base,
    workspaces: [
      { id: W1, name: "Foremost Leads", plan: "internal", createdAt: daysAgo(base, 90) },
      { id: W2, name: "Acme Coaching (SaaS trial)", plan: "trial", createdAt: daysAgo(base, 20) },
    ],
    users: [
      { id: U.owner, workspaceId: W1, email: "arpit@foremostleads.in", name: "Arpit Sharma", role: "owner", clientAccess: JSON.stringify([C.fit, C.iit]), phoneMask: false, twoFactor: true, createdAt: daysAgo(base, 90) },
      { id: U.admin, workspaceId: W1, email: "admin@foremostleads.in", name: "Ops Admin", role: "admin", clientAccess: JSON.stringify([C.fit, C.iit]), phoneMask: false, twoFactor: true, createdAt: daysAgo(base, 80) },
      { id: U.buyer, workspaceId: W1, email: "buyer@foremostleads.in", name: "Media Buyer", role: "media_buyer", clientAccess: JSON.stringify([C.fit]), phoneMask: true, twoFactor: false, createdAt: daysAgo(base, 80) },
      { id: U.rep, workspaceId: W1, email: "rep1@foremostleads.in", name: "Sales Rep 1", role: "sales_rep", clientAccess: JSON.stringify([C.fit, C.iit]), phoneMask: true, twoFactor: false, createdAt: daysAgo(base, 70) },
      { id: U.rep2, workspaceId: W1, email: "rep2@foremostleads.in", name: "Sales Rep 2", role: "sales_rep", clientAccess: JSON.stringify([C.fit]), phoneMask: true, twoFactor: false, createdAt: daysAgo(base, 70) },
      { id: U.viewer, workspaceId: W1, email: "viewer@foremostleads.in", name: "Viewer", role: "viewer", clientAccess: JSON.stringify([C.fit, C.iit, C.saas]), phoneMask: true, twoFactor: false, createdAt: daysAgo(base, 60) },
      { id: U.client, workspaceId: W2, email: "client@acme.co", name: "Acme Client", role: "viewer", clientAccess: JSON.stringify([C.saas]), phoneMask: true, twoFactor: false, createdAt: daysAgo(base, 20) },
    ],
    clients: [
      { id: C.fit, workspaceId: W1, name: "FitLife Coaching", currency: "INR", timezone: "Asia/Kolkata", offerPrice: offers[1].p, attributionWindowDays: 30, attributionModel: "last_paid_click", webhookSecret: "whsec_fit_000", metaPageId: "page_fit", metaPixelId: "px_fit_001", capiEventType: "default", createdAt: daysAgo(base, 90) },
      { id: C.iit, workspaceId: W1, name: "IIT Prep Academy", currency: "INR", timezone: "Asia/Kolkata", offerPrice: offers[1].p, attributionWindowDays: 30, attributionModel: "last_paid_click", webhookSecret: "whsec_iit_000", metaPageId: "page_iit", metaPixelId: "px_iit_001", createdAt: daysAgo(base, 80) },
      { id: C.saas, workspaceId: W2, name: "Acme Coaching", currency: "INR", timezone: "Asia/Kolkata", offerPrice: offers[0].p, attributionWindowDays: 30, attributionModel: "last_paid_click", webhookSecret: "whsec_saas_000", createdAt: daysAgo(base, 20) },
    ],
    funnels: [
      { id: "fn_wb1", clientId: C.fit, type: "webinar", name: "W1 — Transformation Webinar", landingUrls: JSON.stringify(["https://fit.example/w1"]), productIds: JSON.stringify([offers[0].label, offers[1].label]), stages: JSON.stringify(["New", "Registered", "Attended", "Hot", "Call Booked", "Paid", "Lost"]), default: true },
      { id: "fn_co1", clientId: C.fit, type: "call_booking", name: "Cohort Booking", landingUrls: JSON.stringify(["https://fit.example/cohort"]), productIds: JSON.stringify([offers[1].label, offers[2].label]), stages: JSON.stringify(["New", "Call Booked", "Paid", "Lost"]), default: false },
      { id: "fn_call1", clientId: C.iit, type: "call_booking", name: "IIT Mock-test Calls", landingUrls: JSON.stringify(["https://iit.example/call"]), productIds: JSON.stringify([offers[1].label]), stages: JSON.stringify(["New", "Call Booked", "Paid", "Lost"]), default: true },
      { id: "fn_ck1", clientId: C.saas, type: "direct_checkout", name: "Direct Checkout", landingUrls: JSON.stringify(["https://acme.example/checkout"]), productIds: JSON.stringify([offers[0].label]), stages: JSON.stringify(["New", "Paid", "Lost"]), default: true },
    ],
    adAccounts: [
      { id: ACO, metaId: "1234567890", clientId: C.fit, name: "FitLife Ads", currency: "USD", lastPulledAt: daysAgo(base, 0, 3) },
      { id: "aa_222", metaId: "2223334445", clientId: C.iit, name: "IIT Prep Ads", currency: "USD", lastPulledAt: daysAgo(base, 1, 3) },
    ],
    adCampaigns: [
      { metaId: AC, adAccountId: ACO, clientId: C.fit, name: "W1 — Launch + Retarget", status: "ACTIVE" },
      { metaId: "cam_iit_1", adAccountId: "aa_222", clientId: C.iit, name: "IIT Calls", status: "ACTIVE" },
    ],
    adSets: [
      { metaId: AS, adAccountId: ACO, campaignMetaId: AC, clientId: C.fit, name: "W1 Adset 1", status: "ACTIVE" },
      { metaId: "aset_iit_1", adAccountId: "aa_222", campaignMetaId: "cam_iit_1", clientId: C.iit, name: "IIT Adset", status: "ACTIVE" },
    ],
    ads: [
      { metaId: AD1, adAccountId: ACO, adSetMetaId: AS, clientId: C.fit, name: "Video — 30-day transformation", status: "ACTIVE" },
      { metaId: AD2, adAccountId: ACO, adSetMetaId: AS, clientId: C.fit, name: "Static — before/after", status: "ACTIVE" },
      { metaId: AD3, adAccountId: ACO, adSetMetaId: AS, clientId: C.fit, name: "Retargeting — attendees", status: "ACTIVE" },
      { metaId: "ad_iit_1", adAccountId: "aa_222", adSetMetaId: "aset_iit_1", clientId: C.iit, name: "IIT call booking ad", status: "ACTIVE" },
    ],
    creatives: [
      { id: "cr_001", adMetaId: AD1, type: "VIDEO", thumbnailUrl: "https://picsum.photos/seed/fit1/160/90", url: "https://vimeo.com/demo" },
      { id: "cr_002", adMetaId: AD2, type: "IMAGE", thumbnailUrl: "https://picsum.photos/seed/fit2/160/90", url: "https://example.com/img" },
      { id: "cr_003", adMetaId: AD3, type: "CAROUSEL", thumbnailUrl: "https://picsum.photos/seed/fit3/160/90", url: null },
      { id: "cr_004", adMetaId: "ad_iit_1", type: "IMAGE", thumbnailUrl: "https://picsum.photos/seed/iit/160/90", url: null },
    ],
    visitors,
    leads,
    touchpoints,
    events,
    payments,
    tasks,
    notes,
    calls,
    webhooks,
    outbound,
    audit,
    metaForms,
    fieldMappings,
    attributionRules,
    reportConfigs,
    spends,
  };
}

/**
 * Shared Prisma-writing half of the seed (the "DB" half that `prisma/seed.ts`
 * and the e2e/reports tests both call). Writes every row of `buildSeed()` in
 * dependency order. Idempotent for a fresh DB; the e2e test runs it against a
 * temp in-memory file, the CLI runs it against the configured DATABASE_URL.
 */
export async function seedInto(prisma: PrismaClient): Promise<void> {
  const b = buildSeed();
  for (const w of b.workspaces) await prisma.workspace.create({ data: w });
  for (const u of b.users) await prisma.user.create({ data: u });
  for (const c of b.clients) await prisma.client.create({ data: c });
  for (const f of b.funnels) await prisma.funnel.create({ data: f });
  for (const a of b.adAccounts) await prisma.adAccount.create({ data: a });
  for (const c of b.adCampaigns) await prisma.adCampaign.create({ data: c });
  for (const s of b.adSets) await prisma.adSet.create({ data: s });
  for (const a of b.ads) await prisma.ad.create({ data: a });
  for (const cr of b.creatives) await prisma.creative.create({ data: cr });
  for (const v of b.visitors) await prisma.visitor.create({ data: v });
  for (const l of b.leads) await prisma.lead.create({ data: l });
  for (const t of b.touchpoints) await prisma.touchpoint.create({ data: t });
  for (const w of b.webhooks) await prisma.webhookLog.create({ data: w });
  for (const e of b.events) await prisma.event.create({ data: e });
  for (const p of b.payments) await prisma.payment.create({ data: p });
  for (const t of b.tasks) await prisma.task.create({ data: t });
  for (const n of b.notes) await prisma.note.create({ data: n });
  for (const c of b.calls) await prisma.call.create({ data: c });
  for (const o of b.outbound) {
    const dedupKey = o.dedupKey ?? `seed:${o.id}`;
    const row = { ...o, dedupKey } as unknown as Parameters<typeof prisma.outboundEvent.create>[0]["data"];
    await prisma.outboundEvent.create({ data: row });
  }
  for (const a of b.audit) await prisma.auditLog.create({ data: a });
  for (const m of b.metaForms) await prisma.metaLeadForm.create({ data: m });
  for (const m of b.fieldMappings) await prisma.formFieldMapping.create({ data: m });
  for (const r of b.attributionRules) await prisma.attributionRule.create({ data: r });
  for (const r of b.reportConfigs) await prisma.reportConfig.create({ data: r });
  await prisma.spend.createMany({ data: b.spends });
}
