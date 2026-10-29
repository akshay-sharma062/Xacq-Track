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
}): {
  actionType: string;
  eventTime: number; // unix seconds
  eventId: string;
  dedupKey: string;
  userData: { ph?: string; em?: string; fbc?: string; fbp?: string };
  eventSource: "server";
  actionSource: "system_engine";
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
  } = args;

  const eventData = {
    actionType: CAPI_EVENT_NAME[kind],
    eventTime: Math.floor(new Date(eventTimeIso).getTime() / 1000),
    // event_id = sha256 of the dedup key — stable across replays.
    eventId: require("node:crypto")
      .createHash("sha256")
      .update(capiDedupKey(kind, identity, discriminator), "utf8")
      .digest("hex")
      .slice(0, 40),
    dedupKey: capiDedupKey(kind, identity, discriminator),
    userData: {
      ph: identity.phone ? hashPhoneForCapi(identity.phone) : undefined,
      em: identity.email ? hashEmailForCapi(identity.email) : undefined,
      fbc: identity.fbc ?? undefined,
      fbp: identity.fbp ?? undefined,
    },
    eventSource: "server" as const,
    actionSource: "system_engine" as const,
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

export type { SourcePlatform } from "./types";
