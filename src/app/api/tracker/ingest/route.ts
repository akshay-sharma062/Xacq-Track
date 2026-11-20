/**
 * D-17 — public tracker ingest (Phase 3). The tracker.js script (served at
 * /tracker.js) POSTs one page-visit per load, cross-origin, from the
 * FlexiFunnels landing page to our tunnel URL:
 *
 *   POST /api/tracker/ingest
 *   body: { projectId, visitorId, sessionToken, referrer, utmSource, …,
 *          deviceType, osName, …, screenW, screenH, pageUrl, timestamp }
 *
 *   → 200 { ok: true, id }            (the event row landed; the id is the
 *                                       event's cuid — the ONLY thing in the
 *                                       response, no PII: the ticket's rule)
 *   → 204                             (the project is INACTIVE — the tracker
 *                                       JS swallows it, the visit is dropped
 *                                       deliberately, not by accident)
 *   → 404                             (unknown projectId — never write a row
 *                                       for a project that isn't ours)
 *   → 400 { error: "<field> required" }(the exact missing field — the script
 *                                       must be able to log it, not a 500)
 *   → 429                             (the per-project rate limit; the script
 *                                       offline-queues + retries, so no
 *                                       visit is lost on a burst)
 *
 * Security (Phase 5, non-negotiable):
 *   - CORS via the EXISTING /api/ingest pattern (src/lib/cors.ts): the
 *     script POSTs cross-origin with a JSON body → an OPTIONS preflight.
 *   - The IP is captured SERVER-SIDE (cf-connecting-ip → x-real-ip →
 *     x-forwarded-for → remoteAddr) and a client-sent `ip` field is IGNORED
 *     (the spec: "never trust a client-sent ip field"). IPv4 + IPv6: stored
 *     raw, not validated.
 *   - Rate limit is per PROJECT (`rateLimit("tracker:" + projectId)`,
 *     default 120/min, overridable via TRACKER_RATE_LIMIT_PER_MIN).
 *   - No PII in the response: { ok: true, id } only.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/security";
import { corsHeaders, handlePreflight } from "@/lib/cors";
import { clientIpFromHeaders, ingestTrackerEvent } from "@/lib/tracker";
import { noteLiveHost } from "@/lib/live-host";

/** CORS OPTIONS preflight — the browser fires this before the JSON POST
 *  when tracker.js runs on a cross-origin landing page (same as /api/ingest). */
export async function OPTIONS(req: NextRequest) {
  const preflight = await handlePreflight(req);
  return preflight ?? new NextResponse(null, { status: 204 });
}

const TRACKER_RATE_LIMIT_PER_MIN = () => {
  const raw = process.env.TRACKER_RATE_LIMIT_PER_MIN;
  return raw ? Number(raw) || 120 : 120;
};

/** The exact-field 400 validator: the FIRST missing required field is named,
 *  so the script can log it. A malformed body is 400, never a 500. */
function validateTrackerBody(body: any): { ok: true; input: Parameters<typeof ingestTrackerEvent>[1] } | { ok: false; field: string } {
  if (typeof body?.projectId !== "string" || !body.projectId.trim()) return { ok: false, field: "projectId" };
  if (typeof body?.visitorId !== "string" || !body.visitorId.trim()) return { ok: false, field: "visitorId" };
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  // MVP parity: the event kind + WHERE a lead was captured. Only the two
  // documented kinds are accepted (anything else normalises to pageview in
  // the lib, but we keep the wire contract tight).
  const eventType = body.eventType === "lead" ? "lead" : "pageview";
  const leadSource = ["thankyou", "submit", "click", "ajaxSuccess", "manual"].includes(body.leadSource)
    ? body.leadSource
    : null;
  return {
    ok: true,
    input: {
      projectId: body.projectId.trim(),
      visitorId: body.visitorId.trim(),
      sessionToken: str(body.sessionToken),
      eventType,
      leadSource,
      referrer: str(body.referrer),
      utmSource: str(body.utmSource),
      utmMedium: str(body.utmMedium),
      utmCampaign: str(body.utmCampaign),
      utmTerm: str(body.utmTerm),
      utmContent: str(body.utmContent),
      deviceType: str(body.deviceType),
      osName: str(body.osName),
      osVersion: str(body.osVersion),
      browserName: str(body.browserName),
      browserVer: str(body.browserVer),
      screenW: num(body.screenW),
      screenH: num(body.screenH),
      landingUrl: str(body.landingUrl),
      pageUrl: str(body.pageUrl),
      timestamp: str(body.timestamp),
    },
  };
}

export async function POST(req: NextRequest) {
  // D-17 live-host self-capture: a tracker visit that arrives over the live
  // quick-tunnel records that host as Workspace.liveHost (idempotent,
  // localhost-guarded, stale-clobber-guarded, fire-and-forget — it never
  // blocks or throws). This is what keeps the generated install snippet
  // pointing at the CURRENT tunnel host (the subdomain rotates on every
  // cloudflared restart; a stale .env base 404s at FlexiFunnels).
  void noteLiveHost(req);

  // CORS: cross-origin tracker.js page → echo the Origin (public endpoint,
  // no cookies/credentials in the request, so reflecting `*` is safe).
  const baseHeaders: Record<string, string> = req.headers.get("origin")
    ? corsHeaders(req)
    : {};
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new NextResponse(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...baseHeaders, ...extra },
    });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const valid = validateTrackerBody(body);
  if (!valid.ok) {
    // The exact missing field (the ticket: "no 500 on a bad payload — 400
    // with the exact field").
    return json({ error: `${valid.field} required` }, 400);
  }
  const input = valid.input;

  // Per-project rate limit (Phase 5): 120/min default, TRACKER_RATE_LIMIT_PER_MIN
  // overrides. The script offline-queues + retries, so a 429 drops nothing.
  const rl = rateLimit(`tracker:${input.projectId}`, TRACKER_RATE_LIMIT_PER_MIN());
  if (!rl.ok) {
    return json(
      { error: "rate limit exceeded — the tracker re-queues and retries" },
      429,
      { "Access-Control-Expose-Headers": "Retry-After" , "Retry-After": "30" }
    );
  }

  // SERVER-side IP capture (Phase 3): the client-sent `ip` field is DELIBERATELY
  // not read — only the request headers (cf-connecting-ip wins under the
  // Cloudflare tunnel; x-forwarded-for's first hop is the real client).
  const ip = clientIpFromHeaders({
    "cf-connecting-ip": req.headers.get("cf-connecting-ip"),
    "x-real-ip": req.headers.get("x-real-ip"),
    "x-forwarded-for": req.headers.get("x-forwarded-for"),
    remoteAddr: null, // Next.js route handlers don't expose the socket addr
  });

  const res = await ingestTrackerEvent(prisma, input, ip);

  // OK: the event row landed. NO PII in the response (the ticket's rule) —
  // only the ok flag + the event id (for the script's console log).
  if (res.ok) {
    return json({ ok: true, id: res.id });
  }
  // An INACTIVE project: the visit is deliberately dropped (204, no rows) —
  // the tracker.js swallows it via .catch(() => {}).
  if (res.reason === "inactive") {
    return new NextResponse(null, { status: 204, headers: baseHeaders });
  }
  // An UNKNOWN project: 404, never a 500, never a row.
  return json({ error: "unknown project" }, 404);
}
