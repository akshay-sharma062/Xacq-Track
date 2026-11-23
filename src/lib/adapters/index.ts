/**
 * Adapter registry. Maps every spec §6 platform to its adapter so the ingest
 * layer, the integrations hub ("test button"), and the replay tests all use one
 * source of truth.
 */
import { Adapter } from "./types";
import { SourcePlatform } from "../types";
import { metaLeadFormAdapter } from "./meta";
import {
  razorpayAdapter,
  cashfreeAdapter,
  cosmofeedAdapter,
  tagmangoAdapter,
  flexifunnelsAdapter,
} from "./payments";
import {
  aeventAdapter,
  zoomAdapter,
  calendlyAdapter,
  pabblyAdapter,
  whatsappAdapter,
  sheetsAdapter,
  xtAdapter,
  manualAdapter,
} from "./engagements";
import { lovableAdapter } from "./lovable";

export const ADAPTERS: Record<SourcePlatform, Adapter> = {
  meta: metaLeadFormAdapter,
  razorpay: razorpayAdapter,
  cashfree: cashfreeAdapter,
  cosmofeed: cosmofeedAdapter,
  tagmango: tagmangoAdapter,
  flexifunnels: flexifunnelsAdapter,
  aevent: aeventAdapter,
  zoom: zoomAdapter,
  calendly: calendlyAdapter,
  pabbly: pabblyAdapter,
  whatsapp: whatsappAdapter,
  sheets: sheetsAdapter,
  xt: xtAdapter,
  manual: manualAdapter,
  lovable: lovableAdapter,
};

export function adapterFor(platform: SourcePlatform): Adapter {
  return ADAPTERS[platform];
}

/** Human list for the integrations hub screen. */
export function adapterCatalog(): Adapter[] {
  return Object.values(ADAPTERS);
}

// ---------------------------------------------------------------------------
// D-18 — platform CAPABILITY: which platforms CANNOT send a signature /
// secret header. FlexiFunnels support confirmed it only POSTs to a bare
// URL — no API key, no signature, no custom headers. Cosmofeed + TagMango
// share the same "header-less webhook" shape (the repo's simple-gateway
// adapters verify an `x-webhook-secret` header, which these platforms never
// send). So a per-CONNECTION secret on any of them can NEVER be echoed
// back: verify() (if (!secret) return true; else header === secret) fails
// on every real POST (undefined header !== stored secret) → "verification
// failed". These must run UNSIGNED (endpointSecret = "").
//
// D-21 — Lovable joins this list: it has no outbound webhook of its own;
// the only lead-capture path is the PO hand-editing the app's React code to
// `fetch()`-POST our unsigned `/api/webhooks/lovable` endpoint, so it sends
// no signature header either → must run UNSIGNED like the others.
//
// Signed-capable gateways (Razorpay HMAC, Cashfree HMAC, …) are NOT in this
// list — they keep their per-connection secrets and MUST still verify.
// This loosening applies ONLY to the header-less platforms (the D-18
// guardrail); an unsigned connection is bounded by per-connection rate
// limit + client-id + gateway-txn dedup (all already present in the route).
// Single source of truth: integrations.ts (generation + clear-secret) and
// the admin route import isUnsignedOnly() from here — never hardcode the
// list elsewhere.
// ---------------------------------------------------------------------------
export const UNSIGNED_ONLY: readonly SourcePlatform[] = ["flexifunnels", "cosmofeed", "tagmango", "lovable"];

export function isUnsignedOnly(platform: unknown): platform is SourcePlatform {
  return typeof platform === "string" && UNSIGNED_ONLY.includes(platform as SourcePlatform);
}

export type { Adapter, NormalizedInbound } from "./types";
