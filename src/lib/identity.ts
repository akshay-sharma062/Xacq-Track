/**
 * Identity rules (spec section 4).
 *
 * Phone is the join key — in India WhatsApp, not email, is the real channel.
 * Every phone is normalised to E.164 `+91XXXXXXXXXX` before saving. Matching is
 * phone-first, then email. A known visitor cookie that later fills a form
 * attaches that visitor's earlier anonymous touchpoints to the lead. Same phone
 * + different client = different leads; we NEVER merge across clients.
 *
 * All functions are pure and take the inputs they need, so they are trivially
 * unit-testable and safe to run under a replay test (spec rule 8).
 */

// ---------------------------------------------------------------------------
// Phone normalisation (spec 4: strip spaces, leading 0, and 91 prefixes)
// ---------------------------------------------------------------------------
/**
 * Normalise an Indian phone to E.164 `+91XXXXXXXXXX`.
 *
 * Rules, in order:
 *  1. Drop every non-digit except a leading "+".
 *  2. If it starts with "+", the rest must be digits; take the last 10 as the
 *     local number (handles +91 prefix).
 *  3. If it starts with "91" and is 12 digits total, drop the "91".
 *  4. If it starts with "0" (trunk prefix), drop it.
 *  5. The remainder must be a 10-digit Indian mobile/landline number; prefix 91.
 *
 * Returns null when the input can't be a plausible Indian number, so callers
 * can decide (create "source unknown" lead, reject, etc.).
 */
export function normalisePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  const hasPlus = s.startsWith("+");
  s = s.replace(/[\s\-().]/g, ""); // strip spaces, dashes, brackets

  if (hasPlus) {
    s = s.replace(/\+/g, "");
  }

  // Now `s` is digits only (possibly with a leading 0).
  s = s.replace(/^0+/, ""); // drop trunk zeros

  // "91" country prefix on a bare number.
  if (s.length === 12 && s.startsWith("91")) {
    s = s.slice(2);
  }

  // A valid Indian mobile is 10 digits starting with 6-9.
  if (s.length === 10 && /^[6-9]\d{9}$/.test(s)) {
    return `+91${s}`;
  }
  // Landlines: keep it simple — 10 digits accepted too.
  if (s.length === 10 && /^\d{10}$/.test(s)) {
    return `+91${s}`;
  }

  return null;
}

/**
 * Normalise an email for matching: lowercase + trim (spec 4).
 * Returns null when empty.
 */
export function normaliseEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = String(input).trim().toLowerCase();
  return e || null;
}

// ---------------------------------------------------------------------------
// Matching (spec 4: phone first, then email; never across clients)
// ---------------------------------------------------------------------------
export interface MatchInput {
  clientId: string;
  phone?: string | null;
  email?: string | null;
}

export interface MatchResult {
  phoneNormalized: string | null;
  emailNormalized: string | null;
  /** which rule matched, or null when no identity is usable. */
  matchedBy: "phone" | "email" | null;
}

/**
 * Reduce an incoming record to its match keys. Phone always wins over email
 * (spec 4). `matchedBy` is null only when neither phone nor email normalises,
 * in which case the lead is a "source unknown" candidate.
 */
export function resolveMatch(input: MatchInput): MatchResult {
  const phoneNormalized = normalisePhone(input.phone);
  const emailNormalized = normaliseEmail(input.email);
  const matchedBy: MatchResult["matchedBy"] = phoneNormalized
    ? "phone"
    : emailNormalized
    ? "email"
    : null;
  return { phoneNormalized, emailNormalized, matchedBy };
}

/**
 * Pick the winner between two candidate leads for a match, phone-first
 * (spec 4: phone, then email). The `clientIds` guard enforces "never merge
 * across clients": if the two leads belong to different clients this returns
 * null so the caller treats them as distinct, even with identical phone.
 */
export function pickMatchingLead(
  a: { clientId: string; phoneNormalized: string | null; emailNormalized: string | null },
  b: { clientId: string; phoneNormalized: string | null; emailNormalized: string | null }
): "a" | "b" | null {
  if (a.clientId !== b.clientId) return null; // never merge across clients (spec 4)
  if (a.phoneNormalized && a.phoneNormalized === b.phoneNormalized) return "a";
  if (a.emailNormalized && a.emailNormalized === b.emailNormalized) return "a";
  return null;
}

// ---------------------------------------------------------------------------
// Duplicate candidate detection (spec 5.3: same email, different phone).
// ---------------------------------------------------------------------------
/**
 * Two leads in the SAME client that share an email but disagree on phone are
 * "likely duplicates" that a human should review/merge. Returns true when that
 * is the case. Distinct phone AND email = not a duplicate candidate.
 */
export function isDuplicateCandidate(
  a: { emailNormalized: string | null; phoneNormalized: string | null },
  b: { emailNormalized: string | null; phoneNormalized: string | null }
): boolean {
  if (!a.emailNormalized || a.emailNormalized !== b.emailNormalized) return false;
  if (!a.phoneNormalized && !b.phoneNormalized) return false; // no phone to disagree on
  return a.phoneNormalized !== b.phoneNormalized;
}

// ---------------------------------------------------------------------------
// Visitor → lead attach (spec 4): when a known visitor cookie fills a form,
// attach all earlier anonymous touchpoints of that visitor to the lead.
// This is expressed as "the lead inherits the visitor's identity fields"; the
// actual row link (Lead.visitorId) is done by the ingest layer.
// ---------------------------------------------------------------------------
export interface VisitorAttachInput {
  visitor: {
    visitorId: string;
    fbc?: string | null;
    fbp?: string | null;
    // touchpoints' first-seen attribution, carried forward to the lead.
    firstTouch?: {
      utmSource?: string | null;
      campaignId?: string | null;
      adsetId?: string | null;
      adId?: string | null;
    } | null;
  };
}

/** Build the lead fields to set when an anonymous visitor becomes known. */
export function attachVisitorToLead(input: VisitorAttachInput): {
  visitorId: string;
  fbc: string | null;
  fbp: string | null;
  firstTouch: {
    utmSource: string | null;
    campaignId: string | null;
    adsetId: string | null;
    adId: string | null;
  } | null;
} {
  const { visitor } = input;
  const ft = visitor.firstTouch;
  return {
    visitorId: visitor.visitorId,
    fbc: visitor.fbc ?? null,
    fbp: visitor.fbp ?? null,
    firstTouch: ft
      ? {
          utmSource: ft.utmSource ?? null,
          campaignId: ft.campaignId ?? null,
          adsetId: ft.adsetId ?? null,
          adId: ft.adId ?? null,
        }
      : null,
  };
}
