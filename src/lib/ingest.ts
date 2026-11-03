/**
 * The single ingest pipeline (spec architecture: "4 sources in, 3 outputs").
 *
 * EVERY inbound record — Meta lead form, a payment webhook, a webinar join, a
 * WhatsApp message, a CSV import, our own xt.js touchpoint — flows through
 * `processInbound()`. That one choke-point guarantees:
 *   - identity rules (spec 4): phone-first, then email, NEVER across clients,
 *     a known visitor cookie attaches its earlier touchpoints;
 *   - payment dedup (spec 6): idempotent on gateway txn id;
 *   - a payment with no matching lead creates a "source unknown" lead that
 *     still counts in revenue (spec 6);
 *   - auto stage moves (spec 5.5) and audit logging;
 *   - CAPI outbox (spec 5.8): events are enqueued, never sent inline, so a
 *     5,000-webinar-join spike doesn't drop anything and CAPI failures don't
 *     block the webhook ACK.
 *
 * It is written against Prisma so it runs in the Next.js API routes AND in the
 * `node:test`/e2e harness against a real (SQLite) DB.
 */
import { PrismaClient } from "./prisma";
import { normaliseEmail, normalisePhone, isDuplicateCandidate } from "./identity";
import { estimateMatchQuality, capiDedupKey } from "./capi";
import { hashEmailForCapi, hashPhoneForCapi } from "./hash";
import { NormalizedInbound, adapterFor } from "./adapters";
import { EventType, SourcePlatform } from "./types";

// ---------------------------------------------------------------------------
// Auto stage moves (spec 5.5). Event -> target stage (within a funnel).
// ---------------------------------------------------------------------------
const STAGE_FOR_EVENT: Partial<Record<EventType, string>> = {
  registered: "Registered",
  webinar_joined: "Attended",
  webinar_left: "Attended",
  replay_watched: "Attended",
  call_booked: "Call Booked",
  call_done: "Call Booked",
  payment_success: "Paid",
  payment_failed: "Hot",
  refund: "Lost",
};

export interface IngestResult {
  webhookLogId: string;
  status: "processed" | "duplicate" | "failed" | "received";
  leadIds: string[];
  events: number;
  payments: number;
  capiQueued: number;
  error?: string;
}

export interface IngestContext {
  prisma: PrismaClient;
  clientId: string;
  platform: SourcePlatform;
  /** Which shared secret the client uses (for signature verification). */
  clientSecret: string | null;
  rawBody: string; // the exact request body — needed for HMAC + re-processing
  headers: Record<string, string>;
}

export async function processInbound(ctx: IngestContext): Promise<IngestResult> {
  const { prisma, clientId, platform, clientSecret, rawBody, headers } = ctx;
  const raw = safeParse(rawBody);
  const adapter = adapterFor(platform);

  // 1) Verify signature / shared secret BEFORE doing any work (spec 10).
  if (adapter.verify && !adapter.verify(raw, headers, clientSecret)) {
    const log = await prisma.webhookLog.create({
      data: {
        clientId, platform, secret: "verified-failed", status: "failed",
        rawPayload: rawBody, error: "signature/secret verification failed",
      },
    });
    return { webhookLogId: log.id, status: "failed", leadIds: [], events: 0, payments: 0, capiQueued: 0, error: "verification failed" };
  }

  // 2) Parse via the adapter into normalised inbounds.
  const inbounds: NormalizedInbound[] = adapter.parse(raw);
  if (inbounds.length === 0) {
    const log = await prisma.webhookLog.create({
      data: { clientId, platform, secret: "none", status: "processed", rawPayload: rawBody },
    });
    return { webhookLogId: log.id, status: "processed", leadIds: [], events: 0, payments: 0, capiQueued: 0 };
  }

  const result: IngestResult = {
    webhookLogId: "", status: "processed", leadIds: [], events: 0, payments: 0, capiQueued: 0,
  };

  // 3) Process each normalised record in a transaction-per-record so one bad
  //    row doesn't poison the batch (a 5,000-join spike stays lossless).
  for (const rec of inbounds) {
    try {
      await processRecord(prisma, clientId, rec, rawBody, result, headers);
    } catch (e: any) {
      result.status = "failed";
      result.error = e?.message ?? String(e);
    }
  }

  // 4) Log the inbound (spec 5.6: every webhook logged w/ status + retry).
  const log = await prisma.webhookLog.create({
    data: {
      clientId, platform,
      secret: clientSecret ? "shared" : "none",
      status: result.status,
      rawPayload: rawBody,
      eventId: inbounds[0]?.upstreamId ?? null,
      error: result.error ?? null,
    },
  });
  result.webhookLogId = log.id;
  return result;
}

function safeParse(body: string): unknown {
  try { return JSON.parse(body); } catch { return body; }
}

// ---------------------------------------------------------------------------
// One normalised record -> lead(s), event(s), payment(s), CAPI outbox.
// ---------------------------------------------------------------------------
async function processRecord(
  prisma: PrismaClient,
  clientId: string,
  rec: NormalizedInbound,
  rawBody: string,
  result: IngestResult,
  headers: Record<string, string>
): Promise<void> {
  const phone = normalisePhone(rec.phone);
  const email = normaliseEmail(rec.email);
  const isPayment = ["payment_success", "payment_failed", "refund"].includes(rec.type);

  // --- Resolve / create the lead (spec 4 identity rules) -----------------
  let lead = null;
  const match: { phoneNormalized?: string; emailNormalized?: string } = {};
  if (phone) match.phoneNormalized = phone;
  if (email) match.emailNormalized = email;

  // Phone first, then email — but ONLY within this client (never cross-client).
  if (match.phoneNormalized) {
    lead = await prisma.lead.findFirst({
      where: { clientId, phoneNormalized: match.phoneNormalized },
    });
  }
  if (!lead && match.emailNormalized) {
    lead = await prisma.lead.findFirst({
      where: { clientId, emailNormalized: match.emailNormalized },
    });
  }

  const paymentNoLead = isPayment && !lead;
  if (!lead) {
    // spec 6: a payment with no matching lead -> "source unknown" lead,
    // still counts in revenue. Non-payment with no identity -> nothing to do.
    if (paymentNoLead || phone || email || rec.name) {
      lead = await prisma.lead.create({
        data: {
          clientId,
          phone, phoneNormalized: phone ?? null,
          email: rec.email, emailNormalized: email ?? null,
          name: rec.name ?? null,
          city: rec.city ?? null,
          sourceUnknown: paymentNoLead,
          stage: "New",
          visitorId: rec.visitorId ?? null,
        },
      });
    }
  }

  // If we matched/created by a NEW email but a duplicate candidate exists,
  // flag it for the Duplicates review screen (spec 5.3).
  if (lead && email && phone) {
    const twin = await prisma.lead.findFirst({
      where: { clientId, emailNormalized: email, NOT: { id: lead.id } },
    });
    if (twin && isDuplicateCandidate(lead, twin)) {
      await prisma.lead.update({ where: { id: lead.id }, data: { isDuplicateCandidate: true } });
    }
  }

  // Visitor cookie (spec 4). A Visitor row represents "a browser we have seen,
  // before we know who it is". Key off the cookie, NOT the lead: an anonymous
  // ad-click (visitorId but no phone/email) must also create/refresh the
  // Visitor row, and when a lead exists we re-parent this visitor's EARLIER
  // anonymous touchpoints onto it so attribution + the timeline see the full
  // journey. The re-parent runs regardless of whether the visitor row
  // pre-existed (the first record that knew the cookie creates it).
  if (rec.visitorId) {
    let visitor = await prisma.visitor.findUnique({ where: { visitorId: rec.visitorId } });
    if (!visitor) {
      visitor = await prisma.visitor.create({
        data: { visitorId: rec.visitorId, clientId, fbc: rec.fbc ?? null, fbp: rec.fbp ?? null },
      });
    }
    if (lead) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: {
          visitorId: rec.visitorId,
          fbc: (lead as any).fbc ?? visitor.fbc,
          fbp: (lead as any).fbp ?? visitor.fbp,
        },
      });
      // Re-parent this visitor's earlier anonymous (lead-less) touchpoints.
      await prisma.touchpoint.updateMany({
        where: { visitorId: rec.visitorId, leadId: null },
        data: { leadId: lead.id },
      });
    }
  }

  // --- Touchpoint (spec 4: one arrival / one form submit). Written even for
  //      ANONYMOUS visitors (a cookie + ad/UTM but no phone/email yet) so that
  //      when they later fill a form, their earlier ad clicks are already on
  //      file and can be re-parented onto the new lead. Ad-carrying, UTMed, or
  //      cookie-carrying records all produce one.
  const when = toDate(rec.occurredAt);
  const carryAttribution = !!(rec.adId || rec.utmSource || rec.visitorId || isAdTouch(rec.type));
  if (carryAttribution) {
    const adRow = rec.adId ? await prisma.ad.findUnique({ where: { metaId: rec.adId } }) : null;
    await prisma.touchpoint.create({
      data: {
        leadId: lead ? lead.id : null,
        visitorId: rec.visitorId ?? null,
        clientId,
        utmSource: rec.utmSource ?? null,
        utmMedium: rec.utmMedium ?? null,
        utmCampaign: rec.utmCampaign ?? null,
        utmContent: rec.utmContent ?? null,
        utmTerm: rec.utmTerm ?? null,
        campaignId: rec.campaignId ?? null,
        adsetId: rec.adsetId ?? null,
        adId: rec.adId ?? null,
        fbclid: rec.fbclid ?? null,
        fbc: rec.fbc ?? (rec.fbclid ? `fb.${rec.fbclid}` : null),
        fbp: rec.fbp ?? null,
        landingUrl: null,
        referrer: null,
        device: null,
        ip: null,
        kind: rec.type === "meta_form_lead" ? "meta_form_lead" : isAdTouch(rec.type) ? "ad_click" : rec.type === "form_submit" ? "form_submit" : "page_view",
        adRefId: adRow?.metaId ?? null,
        timestamp: when,
      },
    });
  }

  if (!lead) return; // anonymous touchpoint recorded; no lead to attach to.

  result.leadIds.push(lead.id);

  // --- Payment record (dedup on gateway txn id; spec 6) -----------------
  if (isPayment && rec.gatewayTxnId) {
    const exists = await prisma.payment.findUnique({
      where: { gateway_gatewayTxnId: { gateway: rec.gateway ?? "unknown", gatewayTxnId: rec.gatewayTxnId } },
    });
    if (!exists) {
      await prisma.payment.create({
        data: {
          leadId: lead.id, clientId,
          product: rec.product ?? null,
          amount: rec.value != null ? Math.round(rec.value) : 0,
          currency: rec.currency ?? "INR",
          gateway: rec.gateway ?? "unknown",
          gatewayTxnId: rec.gatewayTxnId,
          status: rec.status ?? "pending",
          paidAt: rec.status === "paid" ? toDate(rec.occurredAt) : null,
          refundedAt: rec.status === "refunded" ? toDate(rec.occurredAt) : null,
        },
      });
      result.payments++;
    }
  }

  // --- Timeline event (always). The event keeps a record-level payload (the
  // ad ids + timestamp that attribution reads); the FULL webhook body stays on
  // the WebhookLog row (spec 4: raw kept for re-processing).
  const eventPayload = {
    ad_id: rec.adId ?? null,
    adset_id: rec.adsetId ?? null,
    campaign_id: rec.campaignId ?? null,
    fbclid: rec.fbclid ?? null,
    visitor_id: rec.visitorId ?? null,
    gateway: rec.gateway ?? null,
    gatewayTxnId: rec.gatewayTxnId ?? null,
    product: rec.product ?? null,
    upstreamId: rec.upstreamId ?? null,
    timestamp: when.toISOString(),
  };
  const event = await prisma.event.create({
    data: {
      leadId: lead.id, clientId,
      type: rec.type,
      sourcePlatform: rec.platform,
      value: rec.value ?? null,
      currency: rec.currency ?? "INR",
      minutesWatched: rec.minutesWatched ?? null,
      rawPayload: JSON.stringify(eventPayload),
      timestamp: when,
    },
  });

  // --- Auto stage move (spec 5.5). A payment_success/failed wins over a
  //     "New" default stage set above.
  const target = STAGE_FOR_EVENT[rec.type];
  if (target) {
    const funnel = lead.funnelId
      ? await prisma.funnel.findUnique({ where: { id: lead.funnelId } })
      : null;
    const stages: string[] = parseStringArray(
      funnel?.stages ?? null,
      ["New", "Registered", "Attended", "Hot", "Call Booked", "Paid", "Lost"]
    );
    // Only move FORWARD in the funnel; never push Paid/Lost backwards.
    const curIdx = stages.indexOf(lead.stage);
    const tgtIdx = stages.indexOf(target);
    const forward = tgtIdx > curIdx && curIdx >= 0;
    const isTerminal = lead.stage === "Paid" || lead.stage === "Lost";
    if (!isTerminal && (forward || curIdx === -1)) {
      await prisma.lead.update({ where: { id: lead.id }, data: { stage: target } });
      await prisma.event.create({
        data: {
          leadId: lead.id, clientId, type: "stage_changed", sourcePlatform: "manual",
          rawPayload: JSON.stringify({ from: lead.stage, to: target, auto: true }),
          timestamp: new Date(),
        },
      });
    }
  }

  // --- CAPI outbox (spec 5.8): enqueue, don't send. "Never send twice" via
  //     the unique dedupKey; "never Purchase for a refund" via shouldSend.
  const kind = capiKindFor(rec.type, rec.status);
  if (kind) {
    const identity = {
      clientId, leadId: lead.id,
      phone: lead.phone, email: lead.email,
      fbc: (lead as any).fbc, fbp: (lead as any).fbp,
      clientIp: headers["x-forwarded-for"]?.split(",")[0] ?? headers["x-real-ip"] ?? null,
      userAgent: headers["user-agent"] ?? null,
    };
    const discriminator = isPayment ? rec.gatewayTxnId : undefined;
    const dedupKey = capiDedupKey(kind, identity, discriminator);
    const already = await prisma.outboundEvent.findUnique({ where: { dedupKey } });
    if (!already) {
      await prisma.outboundEvent.create({
        data: {
          clientId, leadId: lead.id, type: kind,
          value: kind === "Purchase" || kind === "Refund" ? (rec.value ?? 0) : null,
          currency: "INR",
          fbc: identity.fbc ?? null, fbp: identity.fbp ?? null,
          hashedPhone: lead.phone ? hashPhoneForCapi(lead.phone) : "",
          hashedEmail: lead.email ? hashEmailForCapi(lead.email) : null,
          clientIp: identity.clientIp ?? null,
          userAgent: identity.userAgent ?? null,
          eventTime: event.timestamp,
          // idempotency key = the full CAPI dedup key (already globally @unique).
          // G4 replay found: the previous `dedupKey.slice(0, 64)` is lossy — two
          // CAPI events for the SAME lead across different gateways share a
          // `Purchase:<client>:<phone>:<txn…>` prefix, so their 64-char
          // truncations collided on the @unique eventId column and 502'd. Store
          // the full key instead (dedupKey is already unique; eventId is a
          // redundant idempotency mirror, never read by the send path).
          eventId: dedupKey,
          dedupKey,
          status: kind === "Refund" ? "skipped" : "queued", // refunds are notes, not sends (spec 5.8)
          matchQuality: estimateMatchQuality(identity),
        },
      });
      result.capiQueued++;
    }
  }

  result.events++;
}

// Map an inbound event to a CAPI event kind (spec 5.8 / section 3). Not every
// event is a CAPI event; only the ones Meta should learn from.
function capiKindFor(type: EventType, status?: string): "Lead" | "CompleteRegistration" | "Attended" | "Schedule" | "Purchase" | "Refund" | null {
  switch (type) {
    case "meta_form_lead":
    case "form_submit":
      return "Lead";
    case "registered":
      return "CompleteRegistration";
    case "webinar_joined":
    case "webinar_left":
    case "replay_watched":
      return "Attended";
    case "call_booked":
      return "Schedule";
    case "payment_success":
      return status === "refunded" ? "Refund" : "Purchase";
    case "payment_failed":
      return null; // no CAPI on a failed payment
    case "refund":
      return "Refund";
    default:
      return null;
  }
}

/** Event types that represent "a person arrived" (spec 4 touchpoint kinds). */
function isAdTouch(type: string): boolean {
  return ["ad_click", "meta_form_lead", "page_view"].includes(type);
}

function toDate(v: unknown): Date {
  if (!v) return new Date();
  const d = v instanceof Date ? v : new Date(v as string | number | Date);
  return isNaN(d.getTime()) ? new Date() : d;
}

/** Parse a JSON-array-of-strings column (e.g. Funnel.stages); fall back on bad JSON. */
function parseStringArray(raw: string | null | undefined, fallback: string[] = []): string[] {
  try {
    const p = JSON.parse(raw ?? "[]");
    return Array.isArray(p) ? p.filter((x) => typeof x === "string") : fallback;
  } catch {
    return fallback;
  }
}
