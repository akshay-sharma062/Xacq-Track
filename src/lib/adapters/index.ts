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
};

export function adapterFor(platform: SourcePlatform): Adapter {
  return ADAPTERS[platform];
}

/** Human list for the integrations hub screen. */
export function adapterCatalog(): Adapter[] {
  return Object.values(ADAPTERS);
}

export type { Adapter, NormalizedInbound } from "./types";
