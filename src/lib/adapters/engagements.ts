/**
 * Engagement + misc platform adapters (spec 6):
 *   - Aevent   : webinar registered / webinar_joined / webinar_left / replay_watched
 *   - Zoom     : webinar registration + attendance (match by email)
 *   - Calendly : call booked / cancelled (match by email + phone question)
 *   - Pabbly   : catch-all routing incl. WhatsApp flows (match by phone)
 *   - WhatsApp : messages sent + replies via WATI / Interakt / AiSensy
 *   - Sheets   : CSV / Google Sheets import (column-mapping driven, manual)
 *
 * Every adapter ships a SAVED SAMPLE PAYLOAD (spec 8) that the replay test in
 * test/adapters.test.ts feeds through parse() to prove the mapping.
 */
import { Adapter, NormalizedInbound } from "./types";

function sharedSecretVerify() {
  return (_p: unknown, headers: Record<string, string>, secret: string | null) => {
    if (!secret) return true; // unsigned dev default
    return headers["x-webhook-secret"] === secret;
  };
}

// ---------------------------------------------------------------------------
// Aevent (webinar platform)
// ---------------------------------------------------------------------------
const AEVENT_SAMPLE = {
  event: "participant.joined",
  campaign: "w1",
  participant: { email: "rakesh@example.com", phone: "9812340001", name: "Rakesh" },
  minutes_watched: 52,
  at: "2024-05-05T18:30:00+05:30",
};

export const aeventAdapter: Adapter = {
  platform: "aevent",
  label: "Aevent (webinars)",
  sample: AEVENT_SAMPLE,
  verify: sharedSecretVerify(),
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const ev = p.event;
    const type: NormalizedInbound["type"] =
      ev === "participant.registered" ? "registered"
      : ev === "participant.joined" ? "webinar_joined"
      : ev === "participant.left" ? "webinar_left"
      : ev === "participant.replayed" ? "replay_watched"
      : "registered";
    return [{
      platform: "aevent",
      type,
      phone: p.participant?.phone, email: p.participant?.email, name: p.participant?.name,
      minutesWatched: p.minutes_watched,
      upstreamId: p.id ?? `${ev}:${p.participant?.email}`,
      occurredAt: p.at,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// Zoom (match by email — spec 6)
// ---------------------------------------------------------------------------
const ZOOM_SAMPLE = {
  event: "meeting.participant_joined",
  meeting: { uuid: "zm_777", topic: "W1 live" },
  user: { email: "sara@example.com", display_name: "Sara" },
  duration_min: 80,
};

export const zoomAdapter: Adapter = {
  platform: "zoom",
  label: "Zoom (webinars)",
  sample: ZOOM_SAMPLE,
  verify: sharedSecretVerify(),
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const ev = p.event;
    const type: NormalizedInbound["type"] =
      ev === "meeting.participant_registered" ? "registered"
      : ev === "meeting.participant_joined" ? "webinar_joined"
      : ev === "meeting.participant_left" ? "webinar_left"
      : "registered";
    return [{
      platform: "zoom",
      type,
      email: p.user?.email, name: p.user?.display_name,
      minutesWatched: p.duration_min,
      upstreamId: p.event_id ?? `${ev}:${p.user?.email}`,
      occurredAt: p.event_ts,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// Calendly (call booked / cancelled; match email + phone question)
// ---------------------------------------------------------------------------
const CALENDLY_SAMPLE = {
  event: "invitee.created",
  resource: { type: "invitee", uid: "cal_5", email: "rohit@example.com", name: "Rohit Iyer" },
  invitee: { question: "What's your phone?", answer: "9812340008" },
  start_time: "2024-05-07T16:00:00+05:30",
};

export const calendlyAdapter: Adapter = {
  platform: "calendly",
  label: "Calendly (calls)",
  sample: CALENDLY_SAMPLE,
  verify: sharedSecretVerify(),
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const ev = p.event;
    const phone = p.invitee?.answer ?? p.resource?.phone;
    const type: NormalizedInbound["type"] =
      ev === "invitee.created" ? "call_booked"
      : ev === "invitee.canceled" ? "call_cancelled"
      : "call_booked";
    return [{
      platform: "calendly",
      type,
      email: p.resource?.email, name: p.resource?.name, phone,
      upstreamId: p.resource?.uid ?? `${ev}:${p.resource?.email}`,
      occurredAt: p.start_time,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// Pabbly Connect (catch-all; also carries WhatsApp flow events)
// ---------------------------------------------------------------------------
const PABBLy_SAMPLE = {
  pabblyId: "pbl_42",
  trigger: "whatsapp.received",
  data: { from: "9812340007", text: "yes, send the link", direction: "in" },
};

export const pabblyAdapter: Adapter = {
  platform: "pabbly",
  label: "Pabbly Connect",
  sample: PABBLy_SAMPLE,
  verify: sharedSecretVerify(),
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    // Pabbly is a router: a WhatsApp message in Pabbly becomes whatsapp_sent/
    // whatsapp_replied depending on direction. Anything else is "form_submit".
    const isWa = String(p.trigger ?? "").startsWith("whatsapp");
    const inbound = p.data?.direction === "in" || p.data?.text;
    const type: NormalizedInbound["type"] = isWa
      ? (inbound ? "whatsapp_replied" : "whatsapp_sent")
      : "form_submit";
    return [{
      platform: "pabbly",
      type,
      phone: p.data?.from,
      upstreamId: p.pabblyId,
      occurredAt: p.timestamp,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// WhatsApp (WATI / Interakt / AiSensy / Periskope — provider webhooks)
// ---------------------------------------------------------------------------
const WHATSAPP_SAMPLE = {
  provider: "wati",
  type: "message",
  message: { whatsapp_jid: "919812340007", body: "replied: interested", from: "me" },
};

export const whatsappAdapter: Adapter = {
  platform: "whatsapp",
  label: "WhatsApp (WATI / Interakt / AiSensy)",
  sample: WHATSAPP_SAMPLE,
  verify: sharedSecretVerify(),
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const fromMe = p.message?.from === "me" || p.direction === "out";
    const phone = p.message?.whatsapp_jid?.replace(/^91/, "") ?? p.phone;
    const type: NormalizedInbound["type"] = fromMe ? "whatsapp_sent" : "whatsapp_replied";
    return [{
      platform: "whatsapp",
      type,
      phone,
      upstreamId: p.message_id,
      occurredAt: p.timestamp,
      raw: p,
    }];
  },
};

// ---------------------------------------------------------------------------
// Google Sheets / CSV import (manual, column-mapping driven).
// The "adapter" here accepts the normalised rows after the import screen maps
// columns -> phone/email/... ; no signature (it's an authenticated upload).
// ---------------------------------------------------------------------------
const SHEETS_SAMPLE = {
  columns: { phone: "Phone", email: "Email", name: "Name", amount: "Amount", status: "Status" },
  rows: [
    { "Phone": "98123 40009", "Email": "neha@example.com", "Name": "Neha", "Amount": "24999", "Status": "Paid" },
  ],
};

export const sheetsAdapter: Adapter = {
  platform: "sheets",
  label: "Google Sheets / CSV import",
  sample: SHEETS_SAMPLE,
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    const cols: Record<string, string> = p.columns ?? {};
    const rows: any[] = p.rows ?? [];
    return rows.map((row, i) => {
      const phone = cols.phone ? row[cols.phone] : null;
      const email = cols.email ? row[cols.email] : null;
      const name = cols.name ? row[cols.name] : null;
      const amount = cols.amount ? Number(row[cols.amount]) : null;
      const statusRaw = cols.status ? String(row[cols.status] ?? "").toLowerCase() : "";
      const status: NormalizedInbound["status"] = statusRaw === "paid" || statusRaw === "refunded"
        ? (statusRaw === "refunded" ? "refunded" : "paid")
        : statusRaw === "failed" ? "failed" : "pending";
      const type: NormalizedInbound["type"] = status === "refunded" ? "refund" : status === "paid" ? "payment_success" : "form_submit";
      return {
        platform: "sheets",
        type,
        phone, email, name,
        value: amount, currency: "INR",
        status, gateway: "sheets",
        gatewayTxnId: `import_row_${i}`,
        upstreamId: `sheet_row_${i}`,
        raw: row,
      } satisfies NormalizedInbound;
    });
  },
};

// ---------------------------------------------------------------------------
// xt.js (our own tracking script — ad clicks / page views / form submits).
// The ingest API posts platform:"xt" batches; this adapter normalises each.
// ---------------------------------------------------------------------------
const XT_SAMPLE = {
  client_id: "cl_fitness",
  visitor_id: "v_001",
  event: "page_view",
  ad_id: "ad_101", adset_id: "aset_1", campaign_id: "cam_launch",
  fbclid: "fb_abc1", fbc: "fb.fb_abc1", fbp: "441231",
  utm_source: "facebook", utm_medium: "ads", utm_campaign: "w1_launch",
  landing_url: "/w1", ts: "2024-05-01T08:00:00+05:30",
};

/** Normalise one xt.js touchpoint object (the `event` field drives the type). */
function xtOne(p: any): NormalizedInbound {
  const ev = p.event;
  const type: NormalizedInbound["type"] =
    ev === "form_submit" ? "form_submit"
    : ev === "checkout_started" ? "checkout_started"
    : p.ad_id ? "ad_click"
    : "page_view";
  return {
    platform: "xt",
    type,
    phone: p.phone ?? null,
    email: p.email ?? null,
    name: p.name ?? null,
    visitorId: p.visitor_id,
    adId: p.ad_id, adsetId: p.adset_id, campaignId: p.campaign_id,
    fbclid: p.fbclid, fbc: p.fbc, fbp: p.fbp,
    utmSource: p.utm_source, utmMedium: p.utm_medium, utmCampaign: p.utm_campaign,
    utmContent: p.utm_content, utmTerm: p.utm_term,
    upstreamId: p.touchpoint_id,
    occurredAt: p.ts,
    raw: p,
  };
}

export const xtAdapter: Adapter = {
  platform: "xt",
  label: "Xacqora tracking script (xt.js)",
  sample: XT_SAMPLE,
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    // The public /api/ingest endpoint posts a batch: { events: Touchpoint[] }.
    // The saved sample (spec 8) is a single event object. Handle both.
    if (p && Array.isArray(p.events)) return p.events.filter(Boolean).map(xtOne);
    return [xtOne(p)];
  },
};

// ---------------------------------------------------------------------------
// Manual (recorded in the app) — passthrough so the UI can post events too.
// ---------------------------------------------------------------------------
export const manualAdapter: Adapter = {
  platform: "manual",
  label: "Manual (logged in Xacqora Track)",
  sample: { type: "note_added", note: "Called, not reached" },
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    return [{
      platform: "manual",
      type: (p.type as NormalizedInbound["type"]) ?? "note_added",
      phone: p.phone, email: p.email, name: p.name,
      upstreamId: p.id,
      raw: p,
    }];
  },
};
