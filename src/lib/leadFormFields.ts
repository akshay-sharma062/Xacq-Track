/**
 * D-19b — the lead-view "Form data" resolver.
 *
 * The card shows the FlexiFunnels form's data for a lead. Identity
 * (name/phone/email/city) lives on the Lead row and is shown by the page with
 * the existing `maskPhone`/`maskEmail` helpers. THIS module extracts only the
 * form-specific data that has no column of its own:
 *
 *   - **custom fields** — the user-named answers ("what's_your_current_it")
 *     + page context (path / landing_url / redirect_url / source_url), carried
 *     on the record's `meta` (D-19) and on the raw body before D-19.
 *   - **UTM extras** — `utm_id` / `utm_flow` (the two UTM-ish values Flexi
 *     sends that have no Touchpoint column; the other five live on the
 *     lead's Touchpoint, which the page already renders as the ad context).
 *   - **fbclid** — the Facebook click id (shown only when present).
 *
 * Two honest sources, in priority order (never invent a value):
 *   1. the newest event whose record-level payload carries a `meta` object;
 *   2. otherwise the linked WebhookLog raw body, re-extracted with
 *      `flexiFormFieldsFromRaw` — the SAME flat-shape extractor the adapter
 *      uses — so a pre-D-19 event falls back without any guessing.
 * Neither present → null (the card hides itself).
 *
 * Pure + testable: no Prisma, no session. PII masking is the caller's job
 * (the page masks the lead's identity lines; the custom values here are the
 * user's own form answers — not phones/emails under a PII key — so they are
 * shown as captured).
 */
import { flexiFormFieldsFromRaw } from "./adapters/payments";
import { Session } from "./session";

/** Mask an email the same way `maskPhone` masks phones (spec 5.10): when the
 *  session must mask PII, show only the last 2 local chars + the domain; when
 *  it may see PII, return the raw value. Lives here (not in session.ts) so the
 *  D-19b commit stays scoped away from the in-progress D-17 `session.ts` diff. */
export function maskEmail(raw: string | null | undefined, session: Pick<Session, "maskPhone">): string {
  if (!raw) return "";
  if (!session.maskPhone) return raw;
  const at = raw.indexOf("@");
  if (at <= 0) return "••••"; // no @ or no local part — nothing safe to keep
  const local = raw.slice(0, at);
  const tail = local.slice(-2) || "••";
  return `${tail}@${raw.slice(at + 1)}`;
}

export interface LeadFormFields {
  /** Where the card's data came from (shown as a provenance note). */
  from: "event-meta" | "webhook-log";
  /** The WebhookLog id when a link was used (null for the event-meta path). */
  webhookLogId: string | null;
  /** The user-named custom form answers + page context (the adapter's `meta`). */
  custom: Record<string, unknown>;
  /** The two UTM-ish values with no Touchpoint column (utm_id / utm_flow). */
  utmExtras: { utm_id?: string; utm_flow?: string };
  /** The Facebook click id, when the body carried one. */
  fbclid?: string;
}

/** Re-extract the form fields from a raw FlexiFunnels body (the pre-D-19
 *  fallback). Unparseable / non-object → null, never a crash. */
export function flexiFormFieldsFromWebhookBody(rawPayload: string): {
  custom: Record<string, unknown>;
  utmExtras: { utm_id?: string; utm_flow?: string };
  fbclid?: string;
} | null {
  let body: unknown;
  try {
    body = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const f = flexiFormFieldsFromRaw(body);
  return {
    custom: f.custom,
    utmExtras: {
      utm_id: f.utm.id,
      utm_flow: (f.custom as Record<string, unknown>).utm_flow as string | undefined,
    },
    fbclid: f.fbclid,
  };
}

/** Resolve the card's form data for a lead's flexi events.
 *
 * @param events the lead's flexi Event rows, NEWEST FIRST (the page's
 *   `orderBy: { timestamp: "desc" }` order), each with its record-level
 *   `rawPayload` + `webhookLogId` provenance link.
 * @param webhookLogRaw the linked WebhookLog.rawPayload body (fetched by the
 *   caller via the `webhookLogId` of the event that links it), or null.
 * @returns the resolved fields, or null when nothing usable is stored. */
export function resolveLeadFormFields(
  events: { rawPayload: string; webhookLogId?: string | null }[],
  webhookLogRaw: string | null,
): LeadFormFields | null {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v !== "" ? v : undefined;

  // 1) The newest event whose record payload carries a `meta` object.
  for (const ev of events) {
    let rec: { meta?: unknown };
    try {
      rec = JSON.parse(ev.rawPayload || "{}");
    } catch {
      continue; // unparseable record — skip, never invent a payload
    }
    const meta = rec.meta;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const custom = meta as Record<string, unknown>;
      return {
        from: "event-meta",
        webhookLogId: ev.webhookLogId ?? null,
        custom,
        utmExtras: {
          utm_id: str(custom.utm_id),
          utm_flow: str(custom.utm_flow),
        },
        fbclid: undefined, // fbclid is consumed onto the record, not the meta
      };
    }
  }

  // 2) Pre-D-19 fallback: the linked raw body, same flat-shape extractor.
  if (webhookLogRaw) {
    const via = flexiFormFieldsFromWebhookBody(webhookLogRaw);
    if (via && (Object.keys(via.custom).length || via.utmExtras.utm_id || via.utmExtras.utm_flow)) {
      const linkId = events.find((e) => e.webhookLogId)?.webhookLogId ?? null;
      return {
        from: "webhook-log",
        webhookLogId: linkId,
        custom: via.custom,
        utmExtras: via.utmExtras,
        fbclid: via.fbclid,
      };
    }
  }

  return null;
}
