/**
 * G8 — per-client Meta pixel (Data Source) mapping, PRD §5.8.
 *
 * The ad-account IDs in META_AD_ACCOUNT_IDS are NOT the pixels. CAPI events
 * POST to a pixel/dataset (the Conversions API object), and §5.8 says "per
 * client: choose which pixel/dataset gets which events." The PO supplied
 * pixel ids keyed by the PO's ad-account *names*; that reconciliation (PO
 * name -> client slug) is recorded as D-07 in DECISIONS.md. The values land
 * in .env as `META_PIXEL_ID_<CLIENTID-UPPER>` (gitignored — pixel ids never
 * appear in a commit; only the key names are documented here / in
 * .env.example). A client with NO configured pixel stays in simulate mode
 * by design (meta/capi.ts), which is the "still lacks a pixel" row in
 * GOLIVE_STATUS.md — not a bug.
 *
 * Multi-pixel clients (D-07): the `<KEY>_ALT` env key stores a second
 * pixel the PO supplied (e.g. a shared or unused-pending-decision one).
 * CAPI sends always use the PRIMARY key; `_ALT` is recorded, not wired.
 *
 * This module is the single reader of that mapping. Read-only + pure:
 * no Prisma, no network.
 */

/**
 * ClientId -> .env key holding its DEFAULT pixel. Value-free on purpose:
 * pixel ids live ONLY in .env (guardrail: never in a commit).
 */
export const META_PIXEL_ENV_KEYS: Record<string, string> = {
  // G1 account ("FML X UPCURVV", high-confidence PO match to Upcurvv-FML).
  cl_upcurvv: "META_PIXEL_ID_CL_UPCURVV",
  // "the job work shop" — primary pixel = "FML & The Job Workshop" (D-07
  // default choice); the Kajabi Landing pixel sits in the _ALT key,
  // unused-pending-decision.
  "cl_the-job-workshop-ad-account": "META_PIXEL_ID_CL_THE_JOB_WORKSHOP_AD_ACCOUNT",
  // PO-confirmed 2026-11-03: "FML X Swaraj" -> CardGenius 2.
  "cl_cardgenius-2": "META_PIXEL_ID_CL_CARDGENIUS_2",
  // PO-confirmed 2026-11-03: "FML x Cracckify" -> FML New.
  "cl_fml-new": "META_PIXEL_ID_CL_FML_NEW",
  // PO-confirmed 2026-11-03: "FML FOR ABHISHEK 2" is this account's pixel
  // (the _ALT key records the pixel it shares with cl_abhishek-pal-fml).
  "cl_fml-x-abhishek-pal": "META_PIXEL_ID_CL_FML_X_ABHISHEK_PAL",
  // "Abhishek Pal - FML" (exact DB account-name match). Distinct ad account
  // from cl_fml-x-abhishek-pal (verified act_1042839737275035 vs
  // act_500594992542527 in the DB), so the PO's one shared pixel id for
  // both names is legitimate — Meta allows one pixel under many accounts.
  "cl_abhishek-pal-fml": "META_PIXEL_ID_CL_ABHISHEK_PAL_FML",
  // D-07: no pixel supplied for cl_piyush-ahuja -> no key here on purpose.
  // Its CAPI queue stays in simulate mode (the "lacks a pixel" case).
};

/**
 * D-12 — per-client CAPI web source URL (the `event_source_url` these Meta
 * pixels require on a "website" action source — subcode 2804039, G8/D-11).
 * PO-supplied landing URLs, stored value-free in .env as
 * `META_EVENT_SOURCE_URL_<CLIENTID-UPPER>` (gitignored — never in a commit).
 * Same value-free pattern as META_PIXEL_ENV_KEYS: code carries the KEY NAMES
 * (the known set, reconciled per client); the VALUES live only in .env.
 *
 * PO adds keys for the remaining clients before running the live re-run —
 * any client WITHOUT a URL stays in simulate mode (the D-11 rule: exact
 * note, never a fabricated URL, never a Meta 400). `cl_piyush-ahuja` has
 * no key on purpose (no URL supplied — D-11/12 "still lacks a URL" case).
 */
export const META_EVENT_SOURCE_URL_ENV_KEYS: Record<string, string> = {
  // PO-supplied 2026-11-05 (D-12):
  cl_upcurvv: "META_EVENT_SOURCE_URL_CL_UPCURVV",
  "cl_cardgenius-2": "META_EVENT_SOURCE_URL_CL_CARDGENIUS_2",
  "cl_abhishek-pal-fml": "META_EVENT_SOURCE_URL_CL_ABHISHEK_PAL_FML",
  "cl_fml-x-abhishek-pal": "META_EVENT_SOURCE_URL_CL_FML_X_ABHISHEK_PAL",
  "cl_fml-new": "META_EVENT_SOURCE_URL_CL_FML_NEW",
  "cl_the-job-workshop-ad-account": "META_EVENT_SOURCE_URL_CL_THE_JOB_WORKSHOP_AD_ACCOUNT",
};

/**
 * Resolve a client's configured CAPI web source URL from .env
 * (`META_EVENT_SOURCE_URL_<CLIENT>`, explicit key first, then the generic
 * per-client key spelling so a PO-added client needs no code change).
 * A value is only accepted when it is a real http(s) URL — a placeholder or
 * a non-URL string returns null (never POSTed to Meta). Pure + read-only:
 * no Prisma, no network.
 */
export function eventSourceUrlForClient(clientId: string): string | null {
  const keys = [
    META_EVENT_SOURCE_URL_ENV_KEYS[clientId],
    `META_EVENT_SOURCE_URL_${clientId.toUpperCase().replace(/-/g, "_")}`,
  ].filter(Boolean);
  for (const key of keys) {
    const v = (process.env[key] ?? "").trim();
    if (v && /^https?:\/\/\S+$/i.test(v)) return v;
  }
  return null;
}

/**
 * The second (ALT) pixel env key for multi-pixel clients. Recorded per D-07
 * ("unused-pending-decision" / "shared with another client") — CAPI sends
 * use only the primary key.
 */
export const META_PIXEL_ALT_ENV_KEYS: Record<string, string> = {
  // Kajabi Landing pixel: unused-pending-decision (D-07).
  "cl_the-job-workshop-ad-account": "META_PIXEL_ID_CL_THE_JOB_WORKSHOP_AD_ACCOUNT_ALT",
  // The pixel shared with cl_abhishek-pal-fml (PO wrote one id for both
  // Abhishek account names): recorded, not wired (D-07).
  "cl_fml-x-abhishek-pal": "META_PIXEL_ID_CL_FML_X_ABHISHEK_PAL_ALT",
};

/**
 * Resolve the configured DEFAULT pixel id for a client ("" / unset = not
 * configured -> simulate mode). Pure + read-only: no Prisma, no network.
 */
export function pixelForClient(clientId: string): string | null {
  const key = META_PIXEL_ENV_KEYS[clientId];
  if (!key) return null;
  const v = (process.env[key] ?? "").trim();
  return v ? v : null;
}

/** The client's recorded ALT pixel, if any (documented-only; not used). */
export function altPixelForClient(clientId: string): string | null {
  const key = META_PIXEL_ALT_ENV_KEYS[clientId];
  if (!key) return null;
  const v = (process.env[key] ?? "").trim();
  return v ? v : null;
}
