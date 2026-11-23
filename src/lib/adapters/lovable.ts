/**
 * D-21 — Lovable (lovable.dev): a React + Vite + Supabase app / landing-page
 * BUILDER. Integrated the way FlexiFunnels (D-18/D-19) was, adapted to what
 * Lovable can ACTUALLY send.
 *
 * VERDICTS (recorded in DECISIONS D-21, the Lovable docs say apps are "backed
 * by editable code" + "synced to GitHub"):
 *   (a) CUSTOM JS INJECTION = YES. The PO can add the D-17 tracker.js
 *       `<script data-project=…>` to the Lovable app's head — Lovable pages
 *       track in Device Track with NO new code here (a TrackingProject + the
 *       generated snippet).
 *   (b) NATIVE FORM→WEBHOOK = NO. Lovable has no builder setting that POSTs a
 *       form's fields to an external URL — its forms write to the app's own
 *       Supabase. Lead capture from Lovable only lands via this adapter when
 *       the PO HAND-EDITS the app's React code to `fetch()`-POST our unsigned
 *       `/api/webhooks/lovable` endpoint with the submitted fields.
 *
 * So this adapter is an UNSIGNED simple-gateway form-capture path (D-18
 * style: no signature header; `endpointSecret = ""`). The PO's hand-wired
 * POST is a FLAT form-submission object (name/phone/email + custom + UTM),
 * the same shape FlexiFunnels sends — so extraction reuses
 * `flexiFormFieldsFromRaw` (one source of truth, like D-19). Tracking-only
 * page_view / form_submit touchpoints also flow in via the `xt`/ingest path,
 * so the adapter's job is to normalise the (optional) lead-webhook POST.
 */
import { Adapter, NormalizedInbound } from "./types";
import { flexiFormFieldsFromRaw } from "./payments";

/** A flat Lovable form-submission POST — what the PO hand-edits into the
 *  app's React code to send. PII is a test fixture, not a captured person. */
export const LOVABLE_FORM_SAMPLE = {
  name: "Aarav Shah",
  email: "aarav@example.com",
  phone: "+919812340010",
  city: "Ahmedabad",
  course: "Data Analytics",
  utm_source: "facebook",
  utm_medium: "paid",
  utm_campaign: "w1_launch",
  fbclid: "PAZXh0_EXAMPLE_FBCLID_0010",
  event: "form_submit",
};

const LovableAdapter: Adapter = {
  platform: "lovable",
  label: "Lovable (tracking + form host)",
  sample: LOVABLE_FORM_SAMPLE,
  // D-18: header-less platform — no signature to verify. Unsigned (empty
  // connection secret) is the only correct shape for Lovable's hand-wired
  // fetch(); a stored secret is never echoed back by a Lovable POST, so a
  // Lovable connection must run UNSIGNED exactly like FlexiFunnels.
  verify(_p, headers, secret) {
    if (!secret) return true; // unsigned dev default / D-18+D-21 unsigned
    return headers["x-webhook-secret"] === secret;
  },
  parse(payload: unknown): NormalizedInbound[] {
    const p = (payload ?? {}) as Record<string, unknown>;
    // Reuse the flat-shape extractor (FlexiFunnels-compatible) — identity +
    // UTM + fbclid + the user-named custom fields (carried in meta so none
    // is lost). A Lovable form POST is a REGISTRATION, never a payment.
    const f = flexiFormFieldsFromRaw(p);
    return [{
      platform: "lovable",
      type: "registered",
      status: "pending",
      phone: f.phone ?? null,
      email: f.email ?? null,
      name: f.name ?? null,
      city: f.city ?? null,
      utmSource: f.utm.source ?? null,
      utmMedium: f.utm.medium ?? null,
      utmCampaign: f.utm.campaign ?? null,
      utmContent: f.utm.content ?? null,
      utmTerm: f.utm.term ?? null,
      fbclid: f.fbclid ?? null,
      gateway: "lovable",
      meta: Object.keys(f.custom).length ? f.custom : undefined,
      raw: p,
    }];
  },
};

export const lovableAdapter = LovableAdapter;
