/**
 * Cryptographic helpers for Meta CAPI (spec 5.8 / section 10).
 *
 * Meta's Conversions API wants event user data SHA-256 hashed BEFORE it leaves
 * our servers — raw phone/email never get sent (spec 10: "Raw values never
 * leave our servers"). This module is the single source of truth for those
 * hashes, so every CAPI path (webhook replay, manual events, scheduled sends)
 * produces byte-identical hashes and Meta's dedup / matching works.
 */
import { createHash } from "node:crypto";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash a phone number for CAPI `ph`.
 * Meta rule: E.164, WITHOUT the leading "+", lowercased, then SHA-256.
 * We normalise first (strip +, spaces, 0/91 prefixes) via identity.normalisePhone
 * when the caller has it; this standalone version defensively cleans what it's
 * handed so a stray "+" never poisons the hash.
 */
export function hashPhoneForCapi(raw: string): string {
  const clean = raw
    .replace(/^\+/, "")
    .replace(/[^\d]/g, "")
    .toLowerCase();
  return sha256Hex(clean);
}

/**
 * Hash an email for CAPI `em`.
 * Meta rule: lowercase, trimmed, SHA-256.
 */
export function hashEmailForCapi(raw: string): string {
  const clean = raw.trim().toLowerCase();
  return sha256Hex(clean);
}

/**
 * Hash a CAPI `event_id` for the dedup idempotency key. We keep a readable
 * raw id in the DB and also expose a stable hash for Meta's `event_id`.
 */
export function hashCapiEventId(raw: string): string {
  return sha256Hex(raw.trim().toLowerCase());
}
