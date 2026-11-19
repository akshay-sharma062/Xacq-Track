/**
 * D-19 — "show payload" admin tooling: render a stored raw webhook body for a
 * connection-log row, with PII masked for roles that must not see it.
 *
 * The raw body is ALREADY persisted on `WebhookLog.rawPayload` (spec 4: "keep
 * raw_payload of every incoming webhook"). A `WebhookConnectionLog` row keys
 * to it by `payloadHash` (SHA-256 of the raw body — the designed link; there is
 * no FK between the two tables, so we match on the hash of the recent rows).
 *
 * Masking follows the existing `session.maskPhone` convention: owner/admin
 * (the only roles that hold `admin_integrations`) have `maskPhone=false` → the
 * FULL value; a role flagged `phoneMask` (spec 5.10) sees phones/emails
 * reduced to their last 4. The PII keys are detected by KEY NAME (the payload
 * field names) and by VALUE PATTERN (a `+91…` phone / an `a@b.c` email), so a
 * real capture under any field name is still masked — but NON-PII fields
 * (utm_*, city, the custom form answers, landing_url, …) pass through.
 */
import { Session } from "./session";
import { PrismaClient } from "./prisma";
import { sha256Hex } from "./integrations";

/** PII keys by name (lowercased). A string under any of these is masked. */
const PII_KEYS = new Set([
  "phone", "mobile", "contact", "whatsapp_number", "phone_number", "tel", "telephone",
  "email", "customer_email", "mail", "e_mail", "user_email",
]);

/** A string that LOOKS like a phone number (any key): optional +, 7-15 digits. */
function looksPhone(v: string): boolean {
  const digits = v.replace(/\D/g, "");
  return (v.trim().startsWith("+") && digits.length >= 7 && digits.length <= 15) ||
    (v.trim() === digits && digits.length === 10); // bare 10-digit IN number
}

function looksEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

/** `••••` + the last 4 chars (the ticket's "last-4" rule, mirroring maskPhone). */
function maskValue(v: string): string {
  const tail = v.slice(-4);
  return `••••${tail}`;
}

/** Recursively mask PII string values in a parsed payload (in place, returns
 *  the masked structure). When `shouldMask` is false, returns the input as-is
 *  (owner/admin see the full value). */
export function maskPayloadStructure(node: unknown, shouldMask: boolean): unknown {
  if (!shouldMask) return node;
  const walk = (v: unknown, key?: string): unknown => {
    if (v && typeof v === "object") {
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val, k.toLowerCase());
      }
      return out;
    }
    if (typeof v === "string") {
      const byKey = key != null && PII_KEYS.has(key);
      const byValue = looksPhone(v) || looksEmail(v);
      if (byKey || byValue) return maskValue(v);
    }
    return v;
  };
  return walk(node);
}

export interface MaskedPayload {
  /** The payload as a parsed object (masked when the role must mask), or the
   *  original raw string when it is not valid JSON. */
  payload: unknown;
  /** True when PII was reduced to last-4 for this role. */
  masked: boolean;
}

/** Parse a raw webhook body + mask it for the acting session (spec 5.10). */
export function maskWebhookPayload(rawPayload: string, session: Session): MaskedPayload {
  let obj: unknown;
  try {
    obj = JSON.parse(rawPayload);
  } catch {
    return { payload: rawPayload, masked: false };
  }
  const shouldMask = session.maskPhone;
  return { payload: maskPayloadStructure(obj, shouldMask), masked: shouldMask };
}

/**
 * Resolve the `WebhookLog` row a connection-log row points at, via its
 * `payloadHash` (SHA-256 of the raw body). Bounded to the most recent rows for
 * the endpoint's client + platform (the conn log + its WebhookLog row are
 * written in the same request, so the match is near the top). Returns null
 * when no recent row hashes to the value (purged, or a pre-hash row).
 */
export async function findWebhookLogForConn(
  prisma: PrismaClient,
  clientId: string,
  platform: string,
  payloadHash: string,
  take = 500
): Promise<string | null> {
  const rows = await prisma.webhookLog.findMany({
    where: { clientId, platform },
    orderBy: { receivedAt: "desc" },
    take,
    select: { rawPayload: true },
  });
  for (const r of rows) {
    if (sha256Hex(r.rawPayload) === payloadHash) return r.rawPayload;
  }
  return null;
}
