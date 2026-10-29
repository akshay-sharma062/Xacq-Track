/**
 * Adapter types. A "platform adapter" takes a raw payload from one integration
 * and produces one or more NORMALISED inbound records (`NormalizedInbound`)
 * that the single ingest pipeline (spec architecture: "4 sources in, 3 outputs")
 * can handle uniformly. Keeping this shape shared means every adapter + the
 * ingest + the replay tests all agree on what "an event about a person" is.
 */
import { EventType, SourcePlatform } from "../types";

export interface NormalizedInbound {
  /** which platform produced this (used for the timeline icon + CAPI source). */
  platform: SourcePlatform;

  // --- Identity (match key: phone first, then email — spec 4) -------------
  phone?: string | null; // raw; ingest normalises to E.164
  email?: string | null; // raw; ingest lowercases/trims
  name?: string | null;
  city?: string | null;

  // --- The event ----------------------------------------------------------
  type: EventType;
  value?: number | null; // monetary (INR)
  currency?: string; // default "INR"
  minutesWatched?: number; // webinar_left / replay_watched

  // --- Payment-specific (dedup + source-unknown, spec 6) ------------------
  gateway?: string; // razorpay | cashfree | cosmo | tagmango | flexifunnels | unknown
  gatewayTxnId?: string; // idempotency key — stops double counting
  status?: "pending" | "paid" | "failed" | "refunded";
  product?: string;

  // --- Attribution carry-through (UTMs / ad ids / visitor, spec: pass
  //     through wherever the platform allows, so a sale carries its own ad).
  visitorId?: string | null;
  adId?: string | null;
  adsetId?: string | null;
  campaignId?: string | null;
  fbclid?: string | null;
  fbc?: string | null;
  fbp?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  utmTerm?: string | null;

  // --- Provenance ---------------------------------------------------------
  /** Upstream id (Meta lead id, Razorpay order id, …) for webhook dedup. */
  upstreamId?: string | null;
  /** When the thing happened; defaults to now. */
  occurredAt?: Date | string;

  /** The raw payload we parsed from (kept for debugging + re-processing). */
  raw?: unknown;
}

export interface Adapter {
  platform: SourcePlatform;
  /** Human label shown in the integrations hub. */
  label: string;
  /** A saved sample payload (spec 8: "every webhook handler gets a saved
   *  sample payload and a test that replays it"). */
  sample: unknown;
  /** Map a raw payload to zero or more normalised inbound records. */
  parse(payload: unknown): NormalizedInbound[];
  /** Optionally verify a signature/secret; returns false when it can't. */
  verify?(payload: unknown, headers: Record<string, string>, secret: string | null): boolean;
}
