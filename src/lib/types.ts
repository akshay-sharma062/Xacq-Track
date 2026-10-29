/**
 * Shared domain types for the framework-free core (spec section 4 event union,
 * section 7 attribution models). These are intentionally decoupled from the
 * Prisma row shapes so the pure logic (attribution, identity, CAPI) is testable
 * without a DB, and so a webhook replay test can feed plain objects in.
 */

// ---------------------------------------------------------------------------
// Events (spec 4 — first version list)
// ---------------------------------------------------------------------------
export type EventType =
  | "ad_click"
  | "page_view"
  | "form_submit"
  | "meta_form_lead"
  | "registered"
  | "webinar_joined"
  | "webinar_left"
  | "replay_watched"
  | "whatsapp_sent"
  | "whatsapp_replied"
  | "call_booked"
  | "call_cancelled"
  | "call_done"
  | "checkout_started"
  | "payment_success"
  | "payment_failed"
  | "refund"
  | "stage_changed"
  | "note_added";

// ---------------------------------------------------------------------------
// Source platforms (spec 6). One inbound URL per client per platform.
// ---------------------------------------------------------------------------
export type SourcePlatform =
  | "meta"
  | "aevent"
  | "zoom"
  | "tagmango"
  | "razorpay"
  | "cashfree"
  | "cosmofeed"
  | "flexifunnels"
  | "calendly"
  | "pabbly"
  | "whatsapp"
  | "xt"
  | "sheets"
  | "manual";

// ---------------------------------------------------------------------------
// Attribution (spec 7)
// ---------------------------------------------------------------------------
export type AttributionModel =
  | "last_paid_click"
  | "first_click"
  | "linear"
  | "lead_source";

/** The ad-bearing touchpoints attribution reads (any source carrying an ad). */
export interface AdClickTouchpoint {
  ts: number; // epoch ms
  adId?: string | null;
  adName?: string | null;
  adsetId?: string | null;
  campaignId?: string | null;
}

// ---------------------------------------------------------------------------
// CAPI outbound event kinds (spec 5.8 / section 3)
// ---------------------------------------------------------------------------
export type CapiEventType =
  | "Lead"
  | "CompleteRegistration"
  | "Attended"
  | "Schedule"
  | "Purchase"
  | "Refund";

/**
 * Normalised identity + context every CAPI payload needs. Kept provider-
 * agnostic; the DB fills `fbc`/`fbp`/ip/ua from the last known touchpoint.
 */
export interface CapiIdentity {
  clientId: string;
  leadId: string | null;
  phone?: string | null; // E.164
  email?: string | null;
  fbc?: string | null; // fb.<fbclid>
  fbp?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
}
