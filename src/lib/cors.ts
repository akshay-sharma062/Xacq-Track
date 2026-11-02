/**
 * Minimal CORS for the public ingest endpoint (spec 5.1).
 *
 * xt.js is pasted on the CLIENT's landing pages (Lovable, FlexiFunnels,
 * TagMango, WordPress, join.upcurvv.com, …) which are a DIFFERENT origin than
 * this app. Its touchpoint POST uses `Content-Type: application/json`, so the
 * browser sends an OPTIONS preflight first. Without a preflight response the
 * POST is blocked and xt.js silently re-queues (spec: never drop events, but
 * also never land). This is a public, shared-secret-signed endpoint (no
 * credentials/cookies in the CORS request), so reflecting `*` is safe.
 */
import { NextRequest, NextResponse } from "next/server";

const ALLOWED_METHODS = "POST, OPTIONS";

export function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin") ?? "*";
  return {
    "Access-Control-Allow-Origin": origin,
    // xt.js sends Content-Type: application/json + a `user-agent` passthrough.
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** Respond to a CORS preflight. Call at the top of a route before auth. */
export function handlePreflight(req: NextRequest): NextResponse | null {
  if (req.method !== "OPTIONS") return null;
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}
