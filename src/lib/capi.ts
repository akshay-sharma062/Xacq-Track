/**
 * Meta Conversions API (spec 5.8 / section 3).
 *
 * We send real outcomes back so Meta optimises for buyers, not form fillers.
 * Every payload carries: hashed phone (SHA-256, E.164 without +) + email, fbc,
 * fbp, event_time, and a value on Purchase. An `event_id` idempotency key lets
 * Meta dedup against our browser pixel. Two hard rules (spec 5.8):
 *   - NEVER send an event twice  -> stable `dedupKey` per (eventKind, identity).
 *   - NEVER send Purchase for a refunded payment -> emit a Refund note instead.
 *
 * This module only BUILDS payloads + dedup keys (pure). The actual send,
 * retry queue and status write are in `src/lib/meta/capi.ts`.
 */
import { createHash } from "node:crypto";
import { hashEmailForCapi, hashPhoneForCapi } from "./hash";
import { CapiEventType, CapiIdentity, SourcePlatform } from "./types";

/** Event kinds we actually send, mapped to Meta's standard/custom names. */
export const CAPI_EVENT_NAME: Record<CapiEventType, string> = {
  Lead: "Lead",
  CompleteRegistration: "CompleteRegistration", // custom: "registered"
  Attended: "Attended", // custom event
  Schedule: "Schedule", // custom: "call_booked"
  Purchase: "Purchase",
  Refund: "Refund", // recorded as a note; not a standard optimisation event
};

/**
 * The dedup key that guarantees "never send twice". One key per
 * (event kind + identity + event-time-bucket). For Purchase it folds in the
 * gateway txn id so two gateways reporting the same sale can't double-send.
 */
export function capiDedupKey(
  kind: CapiEventType,
  identity: CapiIdentity,
  discriminator?: string // e.g. gateway txn id for Purchase/Refund
): string {
  const who = identity.phone ?? identity.email ?? "unknown";
  return `${kind}:${identity.clientId}:${who}:${discriminator ?? ""}`;
}

/**
 * Build the Meta CAPI `data` array (one event). `value` is only set on
 * Purchase/Refund (spec: Purchase with value). Refund carries the negative
 * amount so net revenue is right if Meta does account for it.
 */
export function buildCapiEvent(args: {
  kind: CapiEventType;
  identity: CapiIdentity;
  value?: number | null; // INR
  currency?: string;
  eventTimeIso: string; // ISO 8601
  discriminator?: string;
  pixelId?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  eventSourceUrl?: string | null;
}): {
  actionType: string;
  eventTime: number; // unix seconds
  eventId: string;
  dedupKey: string;
  userData: {
    ph?: string;
    em?: string;
    fbc?: string;
    fbp?: string;
    client_ip_address?: string;
    client_user_agent?: string;
  };
  eventSource: "server"; // internal label (NOT the Meta wire value);
  eventSourceUrl?: string;
  customData: { value?: number; currency?: string };
  partner?: string;
  pixelId?: string;
} {
  const {
    kind,
    identity,
    value,
    currency = "INR",
    eventTimeIso,
    discriminator,
    pixelId,
    clientIp,
    userAgent,
    eventSourceUrl,
  } = args;

  const eventData = {
    actionType: CAPI_EVENT_NAME[kind],
    eventTime: Math.floor(new Date(eventTimeIso).getTime() / 1000),
    // event_id = sha256 of the dedup key — stable across replays.
    eventId: createHash("sha256")
      .update(capiDedupKey(kind, identity, discriminator), "utf8")
      .digest("hex")
      .slice(0, 40),
    dedupKey: capiDedupKey(kind, identity, discriminator),
    userData: {
      ph: identity.phone ? hashPhoneForCapi(identity.phone) : undefined,
      em: identity.email ? hashEmailForCapi(identity.email) : undefined,
      fbc: identity.fbc ?? undefined,
      fbp: identity.fbp ?? undefined,
      // G8: extra user_data signals that raise Meta's Event Match Quality.
      // Both OPTIONAL — an event with no IP/UA still sends; EMQ just has
      // less to match on. Never fabricated.
      // Meta's Conversions API takes `client_ip_address` + `client_user_agent`
      // (NOT `client_ip`/`user_agent`); unknown keys are silently dropped by
      // Meta, so the exact names matter for the EMQ boost.
      client_ip_address: clientIp ?? undefined,
      client_user_agent: userAgent ?? undefined,
    },
    eventSource: "server" as const, // internal label; toMetaWireEvent maps it
    eventSourceUrl: eventSourceUrl ?? undefined, // G8: web source (drives action_source + event_source_url)
    customData:
      value != null ? { value, currency } : {},
  };

  // Drop undefined userData keys (JSON shouldn't carry empty fields).
  const userData = eventData.userData as Record<string, unknown>;
  for (const k of Object.keys(userData)) if (userData[k] === undefined) delete userData[k];

  return {
    ...eventData,
    partner: "Meta",
    pixelId: pixelId ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Send-guard rules (spec 5.8 + 10)
// ---------------------------------------------------------------------------

/**
 * Should this purchase be sent as a CAPI Purchase at all?
 *  - Refunded payments -> NO. We record a Refund note instead (spec 5.8).
 *  - A source-unknown lead still counts in revenue and IS sent if we have a
 *    phone/email to hash; without any identity, Meta can't match, so we skip.
 */
export function shouldSendPurchase(args: {
  refunded: boolean;
  identity: CapiIdentity;
}): { send: boolean; reason: string } {
  if (args.refunded) {
    return { send: false, reason: "spec 5.8: never send Purchase for a refunded payment (Refund note instead)." };
  }
  if (!args.identity.phone && !args.identity.email) {
    return { send: false, reason: "no phone/email to hash — Meta cannot match." };
  }
  return { send: true, reason: "ok" };
}

/** Match-quality heuristic we log before Meta reports its own (0–10 scale). */
export function estimateMatchQuality(id: CapiIdentity): number {
  let q = 0;
  if (id.phone) q += 4; // hashed phone is the strongest signal (spec 3).
  if (id.email) q += 3;
  if (id.fbc) q += 2;
  if (id.fbp) q += 1;
  return Math.min(10, q);
}

// ---------------------------------------------------------------------------
// G8 live path — Meta wire format + Event Match Quality read-back
// ---------------------------------------------------------------------------

/**
 * The Meta wire-format `event_id` for a stored dedup key: the stable
 * 40-char hash Meta dedups on. G8 freeze: `sendQueue` derives it from the
 * row's STORED `dedupKey` (immutable) — never from a re-derived
 * discriminator or the live lead's (mutable) phone/email — so retries of
 * the same row always POST the same event_id and Meta's dedup can never
 * see a "new" event (the colon-in-txn-id / identity-change fragilities
 * are eliminated).
 */
export function capiWireEventId(dedupKey: string): string {
  return createHash("sha256").update(dedupKey, "utf8").digest("hex").slice(0, 40);
}

/**
 * Meta's Conversions API event names for our internal CAPI_EVENT_NAME values.
 * Standard events MUST carry Meta's standard name (or the event is treated
 * as a custom event and won't match a standard-event pixel optimisation);
 * "Attended" is our custom event, sent verbatim.
 */
const META_STANDARD_EVENT_NAMES: Record<string, string> = {
  Lead: "LEAD",
  Purchase: "PURCHASE",
  Refund: "REFUND",
  CompleteRegistration: "COMPLETE_REGISTRATION",
  Schedule: "SCHEDULE",
  Attended: "Attended", // custom event — keep our name
};

/**
 * G8 (D-07): Meta's `action_source` for our WEB-funnel CAPI events.
 *
 * Meta's live 400 on the labelled replay (subcode 2804039) rejected the
 * server-side value "system": *"Provide a valid value for the action source
 * parameter, such as 'website'."* Our events carry a client UA + IP (web
 * signals), so a WEB source value is what Meta expects. When such a source
 * is used, Meta ALSO requires `event_source_url` (emitted alongside
 * `client_user_agent`). This is a named constant so a Meta-side value change
 * is a ONE-LINE flip.
 *
 * Value history (each driven by Meta's own 400 on the labelled replay,
 * subcode 2804039): "system" rejected (our events carry web signals) →
 * "browser" rejected, Meta's hint: "such as 'website'" → **"website"** is the
 * value Meta's v23.0 error prescribes for this pixel's web events.
 *
 * When no source URL is available (e.g. a client with no funnel landing
 * URL), toMetaWireEvent falls back to the non-web "system" value — a valid
 * server-side source that does not require `event_source_url`.
 */
const CAPI_ACTION_SOURCE = "website";

/**
 * Map one `buildCapiEvent` payload to Meta's Conversions API wire format
 * (`POST /<pixel>/events`): flat per-event object with `event_name`,
 * `event_time`, `event_id`, `user_data`, `custom_data`.
 *
 * WHY THIS EXISTS: G4's live CAPI POSTs 400'd ("Unsupported post request.
 * Object with ID 'pixel' does not exist") because (a) the URL carried the
 * literal placeholder `pixel` — no per-client pixel was configured — and
 * (b) the body nested our internal envelope, which Meta's endpoint does
 * not accept. This transformer is the wire shape Meta actually wants; the
 * internal envelope (with its `partner`/`dedupKey` bookkeeping) stays for
 * the dedup + test assertions.
 *
 * G8 live-replay proof (2026-11-03): Meta's real 400 on our wire shape was
 * `"The parameter $['data'][0]['event_name'] is required."` — so the
 * REQUIRED `event_name` is set here (from the standard-name map above), and
 * `custom_data.currency` is sent as `currency_code` (Meta's field name).
 *
 * `wireEventId` (G8): the frozen event_id to send (default: the payload's
 * own derived one — stable for freshly-built events; sendQueue passes the
 * row-stored `capiWireEventId(row.dedupKey)` instead).
 */
export function toMetaWireEvent(
  ev: ReturnType<typeof buildCapiEvent>,
  wireEventId?: string
): Record<string, unknown> {
  // G8 (D-07): our events carry a client UA + IP (web signals). A WEB
  // `action_source` (CAPI_ACTION_SOURCE) is what Meta's live 400 asked for,
  // and that value REQUIRES `event_source_url` — so the two are emitted
  // together, and only when we actually have a source URL. When no source
  // URL is available we fall back to the non-web "system" source, which is
  // valid on its own and needs no URL. `event_source` was an internal label,
  // not a Meta field, so it never leaks into the wire object.
  const isWebSource = Boolean(ev.eventSourceUrl);
  // D-11: a NON-web ("system") action source must not carry WEB-only
  // user_data signals (client_ip_address / client_user_agent) — Meta 400s
  // them on a non-web source (subcode 2804039 "…such as 'website'"; the
  // G4-era rows have no Funnel landing URL, so they fall to "system" while
  // still carrying a web ip/ua → the 400). The identity match signals
  // (ph/em/fbc/fbp) are KEPT — they drive EMQ regardless of source. Web
  // signals are only sent on a "website" source (which pairs with
  // event_source_url). No value is fabricated either way.
  const wireUserData: Record<string, unknown> = { ...ev.userData };
  if (!isWebSource) {
    delete wireUserData.client_ip_address;
    delete wireUserData.client_user_agent;
  }
  const wire: Record<string, unknown> = {
    // G8: Meta's required event-name field (standard names for standard
    // events, our custom name for Attended).
    event_name: META_STANDARD_EVENT_NAMES[ev.actionType] ?? ev.actionType,
    action_type: ev.actionType,
    event_time: ev.eventTime,
    // event_id (our stable dedup hash) is how Meta dedups against the
    // browser pixel that emitted the same event_id.
    event_id: wireEventId ?? ev.eventId,
    user_data: wireUserData,
    action_source: isWebSource ? CAPI_ACTION_SOURCE : "system",
  };
  if (isWebSource) wire.event_source_url = ev.eventSourceUrl;
  if (Object.keys(ev.customData).length > 0) {
    // Meta's custom_data uses `currency_code` (ISO 4217), not `currency`.
    wire.custom_data = { ...ev.customData, currency_code: ev.customData.currency };
    delete (wire.custom_data as Record<string, unknown>).currency;
  }
  return wire;
}

/**
 * Normalize Meta's raw `event_match_quality` (a 0–10 number in this API
 * version; older/newer versions report a level string) to an int 0–10 for
 * persistence in `OutboundEvent.matchQuality` — ONLY when Meta actually
 * returned one. `null` = Meta reported no EMQ for this event (absence is
 * not a score; we never invent a number). The caller sets
 * `emqFromMeta=true` only for non-null results so the dashboard can
 * distinguish Meta-reported from locally-estimated.
 */
export function normalizeMetaEmq(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.min(10, Math.round(raw)));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.min(10, Math.round(n)));
    // level strings ("low"/"medium"/"high"/"exact"/"probable" …) have no
    // authoritative 0–10 value — we refuse to guess.
    return null;
  }
  return null;
}

export type { SourcePlatform } from "./types";
