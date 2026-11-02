/**
 * Public ingest endpoint for our own tracking script (xt.js, spec 5.1).
 *
 * xt.js posts `POST /api/ingest` with `{ client, events: TouchpointBatch[] }`
 * where each event is one arrival / form-submit / checkout-start. This flows
 * through the SAME single pipeline as every other webhook (spec architecture:
 * "4 sources in, 3 outputs"), so ad clicks, page views and form fills land on
 * the right lead within a minute, carry their UTMs/ad ids, and re-parent the
 * visitor's earlier anonymous touches.
 *
 * Rate-limited per client (spec 10). No shared secret: it is public — a bad
 * actor can only flood, which the rate limit + a client-id check bound.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processInbound } from "@/lib/ingest";
import { rateLimit } from "@/lib/security";
import { corsHeaders, handlePreflight } from "@/lib/cors";

/**
 * CORS OPTIONS preflight — the browser fires this before the JSON POST when
 * xt.js runs on a cross-origin page (spec 5.1).
 */
export async function OPTIONS(req: NextRequest) {
  const preflight = await handlePreflight(req);
  return preflight ?? new NextResponse(null, { status: 204 });
}

export async function POST(req: NextRequest) {
  // Same origin (the app's own pages call /api/ingest) → no CORS needed.
  // Cross-origin xt.js page → echo the Origin so the browser accepts the POST.
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

  const clientId: string | undefined = body?.client ?? body?.client_id;
  if (!clientId) return json({ error: "client required" }, 400);

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return json({ error: "unknown client" }, 404);

  const rl = rateLimit(`xt:${clientId}`);
  if (!rl.ok) {
    return json(
      { error: "rate limit exceeded — events re-queued in localStorage by xt.js" },
      429
    );
  }

  // Re-wrap the batch as an xt adapter payload so it normalises identically
  // to a server-generated touchpoint (spec 6: xt.js).
  const events: any[] = Array.isArray(body?.events) ? body.events : [body];
  const rawBody = JSON.stringify({ platform: "xt", events });

  const res = await processInbound({
    prisma,
    clientId,
    platform: "xt",
    clientSecret: null, // public endpoint — the client id IS the scoping key
    rawBody,
    headers: { "user-agent": req.headers.get("user-agent") ?? "" },
  });

  return json({
    accepted: true,
    events: res.events,
    leadIds: res.leadIds,
  });
}
