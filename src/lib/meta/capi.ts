/**
 * Meta CAPI send + retry queue (spec 5.8).
 *
 * Reads queued OutboundEvent rows, sends each to Meta's Conversions API, and
 * writes back status / matchQuality / sentToMeta / error. Enforces the two
 * hard rules from the spec:
 *   - NEVER send an event twice (dedupKey is unique + we skip already-sent).
 *   - NEVER send a Purchase for a refunded payment (ingest already skips it;
 *     a refund shows up as a skipped "Refund" note, not a send).
 *
 * `sendQueue()` is safe to run on a schedule (the "retry queue").
 * `dryRun`/`simulate` mode lets the demo + tests run with no network.
 */
import { PrismaClient } from "../prisma";
import { buildCapiEvent, shouldSendPurchase, toMetaWireEvent, normalizeMetaEmq, capiWireEventId } from "../capi";
import { CapiIdentity, CapiEventType } from "../types";

/**
 * D-11 — send-boundary pixel validation. Meta's Conversions API pixel /
 * data-source ids are NUMERIC strings (10–18 digits). Anything else — the
 * G4-era placeholder word "pixel", a too-short id, an empty value — is
 * REJECTED before any network call so a placeholder can never reach Meta and
 * 400 again ("Unsupported post request. Object with ID 'pixel' does not
 * exist" was the stale G4 400 persisted on the Nov-3 OutboundEvent rows).
 */
export function isValidMetaPixelId(v: unknown): v is string {
  return typeof v === "string" && /^[0-9]{6,20}$/.test(v.trim());
}

/**
 * A CAPI send mode:
 *  - "live"     -> META_ACCESS_TOKEN + a valid numeric per-client pixel are
 *                  present: a REAL POST to Meta's Conversions API. EMQ + ack
 *                  are read back.
 *  - "simulate" -> token absent, OR the pixel is absent/invalid (D-11:
 *                  a placeholder pixel like "pixel" is rejected, not sent):
 *                  mark sent locally, NO network. (Never a canned
 *                  live-success — `simulated` is set so the dashboard can't
 *                  present it as live.)
 */
export interface SendOutcome {
  total: number;
  sent: number;
  failed: number;
  skipped: number; // already sent / refunded / no identity
  simulated: number; // sent-locally (no token/pixel) — NOT a live Meta send
  live: number; // actually POSTed to Meta's Conversions API
  errors: string[];
}

/**
 * Send all queued CAPI events for a client to Meta.
 *
 * G8 flip (spec 5.8):
 *  - LIVE   when BOTH a Meta access token AND the client's pixel are present:
 *            a real POST to `graph.facebook.com/<ver>/<pixel>/events` (Meta's
 *            Conversions API). Meta's ack (fbtrace_id / returned event_id) +
 *            its own Event Match Quality are read back and persisted.
 *  - SIMULATE when the token OR the pixel is absent: mark sent locally, NO
 *            network. The row is flagged `simulated=true` so the dashboard
 *            can never present a simulate as a live Meta send (D-05 honesty
 *            rule). This is also the offline-demo / test path.
 *
 * A 4xx/403 from Meta is recorded on the row with the EXACT error string
 * (BLOCKED, not a canned success) and retried on the next queue run.
 *
 * @param opts.fetch  injectable fetch (tests mock Meta's HTTP here).
 */
export async function sendQueue(
  prisma: PrismaClient,
  clientId: string,
  opts: {
    metaAccessToken?: string;
    metaPixelId?: string | null;
    apiVersion?: string;
    now?: Date;
    fetch?: typeof fetch;
    /** D-11: explicit web source URL for this client's events. When set,
     *  events carry action_source "website" + event_source_url (Meta's
     *  required pairing); when absent, the default Funnel landing URL is
     *  used; when neither exists, a live POST would be Meta-invalid (2804039)
     *  → the queue stays simulated with a note (never POSTs a no-URL
     *  "system" event, never fakes a URL). Injectable so the rule is testable. */
    eventSourceUrl?: string | null;
  } = {}
): Promise<SendOutcome> {
  const {
    metaAccessToken = process.env.META_ACCESS_TOKEN ?? "",
    metaPixelId = null,
    apiVersion = process.env.META_API_VERSION ?? "v23.0",
    now = new Date(),
    fetch: doFetch = fetch,
  } = opts;

  // Queued (or failed, to retry) — never "sent" again (dedup rule, spec 5.8).
  const rows = await prisma.outboundEvent.findMany({
    where: { clientId, status: { in: ["queued", "failed"] } },
    include: { lead: true },
  });

  const out: SendOutcome = { total: rows.length, sent: 0, failed: 0, skipped: 0, simulated: 0, live: 0, errors: [] };
  if (rows.length === 0) return out;

  // G8 (D-07) + D-11: the WEB source for this client's CAPI events. Meta
  // requires `event_source_url` alongside a web `action_source` — so we pair
  // them from the client's DEFAULT funnel's first landing URL (a real value,
  // never fabricated). If the client has no funnel landing URL, `eventSourceUrl`
  // stays undefined and — D-11 — a live POST is NOT made (Meta's subcode
  // 2804039 rejects the "system" fallback these pixels only accept "website"
  // for): the queue stays simulated with an explicit note instead.
  const funnel = await prisma.funnel.findFirst({
    where: { clientId, default: true },
    select: { landingUrls: true },
  });
  // D-11: an explicitly injected source URL (tests / callers) wins; else the
  // client's default Funnel landing URL (the real value, never fabricated).
  const eventSourceUrl = opts.eventSourceUrl ?? (() => {
    // Funnel.landingUrls is a JSON array (schema:88, e.g. '["https://…/w1"]').
    if (!funnel?.landingUrls) return undefined;
    let urls: string[];
    try {
      const parsed = JSON.parse(funnel.landingUrls);
      urls = Array.isArray(parsed) ? parsed.map((u) => String(u).trim()) : [String(parsed).trim()];
    } catch {
      urls = []; // malformed JSON — treat as "no source URL", never crash the send
    }
    return urls.find((s) => s.startsWith("http://") || s.startsWith("https://")) ?? undefined;
  })();

  for (const row of rows) {
    const lead = row.lead ?? null;
    const identity: CapiIdentity = {
      clientId,
      leadId: row.leadId,
      phone: lead?.phone ?? null,
      email: lead?.email ?? null,
      fbc: row.fbc,
      fbp: row.fbp,
      clientIp: row.clientIp ?? null,
      userAgent: row.userAgent ?? null,
    };

    // A refunded payment must never be sent as Purchase (spec 5.8). Ingest
    // already skips these; this is a second, independent guard.
    const refunded = row.type === "Refund";
    const guard = refunded
      ? { send: false, reason: "refund note — not a send" }
      : shouldSendPurchase({ refunded: lead?.stage === "Lost" && row.type === "Purchase", identity });
    if (!guard.send) {
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { status: "skipped", error: guard.reason, sentToMeta: false },
      });
      out.skipped++;
      continue;
    }

    // Build the payload (hashed phone/email + fbc/fbp + value + IP/UA for EMQ).
    // G8 freeze: the wire event_id is derived from the row's STORED dedupKey
    // (immutable) — never a re-derived discriminator or the mutable lead
    // identity — so a retry of this row always POSTs the same event_id and
    // Meta's dedup can't see a "new" event.
    const kind = row.type as CapiEventType;
    const payload = buildCapiEvent({
      kind,
      identity,
      value: row.type === "Purchase" || row.type === "Refund" ? row.value : null,
      currency: row.currency ?? "INR",
      eventTimeIso: row.eventTime.toISOString(),
      pixelId: metaPixelId,
      clientIp: row.clientIp ?? null,
      userAgent: row.userAgent ?? null,
      // G8 (D-07): the client's default-funnel landing URL pairs with the web
      // action_source → event_source_url (a real value; undefined → the wire
      // event falls back to the non-web "system" source).
      eventSourceUrl,
    });
    const wireEvent = toMetaWireEvent(payload, capiWireEventId(row.dedupKey));

    if (!metaAccessToken || !isValidMetaPixelId(metaPixelId)) {
      // Simulate (no token OR a pixel that is absent/NOT a valid numeric
      // Meta id — D-11). A placeholder like "pixel" must NEVER be POSTed to
      // Meta (that was the stale G4 400 "Object with ID 'pixel' does not
      // exist"): we mark the row sent locally and say exactly why, so the
      // dashboard shows a simulate note, not a fake live-success.
      const reason = !metaAccessToken
        ? "simulate: no META_ACCESS_TOKEN (local mark, no network)"
        : !metaPixelId
          ? "simulate: no pixel configured for this client (local mark, no network)"
          : `simulate: pixel '${metaPixelId}' is not a valid numeric Meta pixel/dataset id — placeholder rejected at the send boundary, never POSTed to Meta (local mark, no network)`;
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: {
          status: "sent",
          simulated: true,
          sentAt: now,
          error: reason,
          pixelUsed: null, // never record a placeholder as "the pixel used"
        },
      });
      out.sent++;
      out.simulated++;
      out.errors.push(`${row.dedupKey}: ${reason}`);
      continue;
    }

    // D-11: a live send with NO source URL is Meta-invalid on these pixels —
    // G8/D-07 record + this run's live 400: Meta subcode 2804039 rejects the
    // non-web "system" action_source and prescribes "website", which REQUIRES
    // event_source_url. A source URL is never fabricated. So: no URL → stay
    // SIMULATED with an explicit note (the ticket's "or stay simulated with a
    // note" branch), retriable once the client's default Funnel has a landing
    // URL. A pixel-bearing live POST only happens with a real source URL.
    if (!eventSourceUrl) {
      const reason = `simulate: no funnel source URL for this client — these Meta pixels only accept a web ("website") source + event_source_url (Meta 400 subcode 2804039, G8/D-07 record), and a URL is never fabricated; the live send activates once the client's default Funnel has a landing URL (pixel ${metaPixelId} validated, NOT POSTed)`;
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { status: "sent", simulated: true, sentAt: now, error: reason, pixelUsed: null },
      });
      out.sent++;
      out.simulated++;
      out.errors.push(`${row.dedupKey}: ${reason}`);
      continue;
    }

    // LIVE send to Meta's Conversions API (real pixel, real token, real
    // source URL) — via the shared postOneCapiEvent primitive (also used by
    // scripts/g8-replay.ts).
    const res = await postOneCapiEvent({
      pixel: metaPixelId,
      token: metaAccessToken,
      wireEvent,
      apiVersion,
      fetch: doFetch,
    });
    if (!res.ok) {
      // BLOCKED, not faked: record the EXACT Meta error string (4xx/403 or a
      // network throw). The row stays retryable (status "failed").
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { status: "failed", error: res.error ?? "network error", simulated: false },
      });
      out.failed++;
      out.errors.push(`${row.dedupKey}: ${res.error ?? "network"}`);
      continue;
    }
    // Meta accepted. Read back its OWN Event Match Quality + the returned
    // event ids — persisted honestly (emqFromMeta only when Meta reported a
    // usable number; Meta's verbatim value kept in metaEmq; absence is not a
    // score and is never invented).
    const emqNorm = normalizeMetaEmq(res.emqRaw);
    await prisma.outboundEvent.update({
      where: { id: row.id },
      data: {
        status: "sent",
        sentToMeta: true,
        simulated: false,
        pixelUsed: metaPixelId,
        metaAckId: res.fbtraceId,
        metaEmq: res.emqRaw == null ? null : String(res.emqRaw),
        emqFromMeta: emqNorm != null,
        // Meta's reported EMQ wins when it came back; otherwise keep the
        // local estimate (D-05: never mix the two in the UI).
        matchQuality: emqNorm ?? row.matchQuality ?? null,
        sentAt: now,
        error: null,
      },
    });
    out.sent++;
    out.live++;
  }

  // Also mark any lead events sent (spec 5.8 shows status per event).
  await prisma.event.updateMany({
    where: { clientId, type: { in: ["registered", "webinar_joined", "call_booked", "payment_success"] }, sentToMeta: false },
    data: { sentToMeta: true },
  });

  return out;
}

/**
 * G8 — the single shared live-POST primitive: one wire event to Meta's
 * Conversions API. Used by BOTH the retry queue (`sendQueue`) and the
 * labelled replay proof (`scripts/g8-replay.ts`), so the exact URL /
 * headers / body shape have one source of truth and the replay exercises
 * the real send path, not a copy of it.
 *
 * Returns a structured result — never throws — so callers persist exactly
 * what Meta said (the "BLOCKED, not faked" rule: a 4xx comes back with the
 * EXACT Meta error string, not a canned success).
 */
export interface PostOneCapiResult {
  ok: boolean;
  httpStatus: number | null; // null = a network throw, not an HTTP status
  error: string | null; // exact Meta error string on failure
  fbtraceId: string | null; // Meta's ack id
  metaEventId: string | null; // Meta's returned event id (event_hub_log_view[0].event_id)
  emqRaw: unknown; // Meta's event_match_quality verbatim (null = not reported)
}

export async function postOneCapiEvent(args: {
  pixel: string;
  token: string;
  wireEvent: Record<string, unknown>; // one toMetaWireEvent() output
  apiVersion?: string;
  fetch?: typeof fetch;
}): Promise<PostOneCapiResult> {
  const {
    pixel,
    token,
    wireEvent,
    apiVersion = process.env.META_API_VERSION ?? "v23.0",
    fetch: doFetch = fetch,
  } = args;
  // D-11 send-boundary guard (defense-in-depth — `sendQueue` already
  // simulates invalid pixels, but this primitive is also called directly by
  // scripts/g8-replay.ts): a placeholder / non-numeric pixel id must NEVER
  // form a Meta URL. Reject with a clear, non-network error (ok:false,
  // httpStatus:null) — the caller persists it as a BLOCKED note.
  if (!isValidMetaPixelId(pixel)) {
    return {
      ok: false,
      httpStatus: null,
      error: `REJECTED at send boundary: pixel '${String(pixel).slice(0, 40)}' is not a valid numeric Meta pixel/dataset id (expected 6-20 digits) — no request sent to Meta`,
      fbtraceId: null,
      metaEventId: null,
      emqRaw: null,
    };
  }
  try {
    const res = await doFetch(
      `https://graph.facebook.com/${apiVersion}/${pixel}/events?access_token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [wireEvent] }),
      }
    );
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: `${res.status} ${JSON.stringify(body).slice(0, 400)}`,
        fbtraceId: null,
        metaEventId: null,
        emqRaw: null,
      };
    }
    const hub = body?.event_hub_log_view?.[0];
    return {
      ok: true,
      httpStatus: res.status,
      error: null,
      fbtraceId: typeof body?.fbtrace_id === "string" ? body.fbtrace_id : null,
      metaEventId: hub && typeof hub.event_id === "string" ? hub.event_id : null,
      emqRaw: hub?.event_match_quality ?? null,
    };
  } catch (e: any) {
    return { ok: false, httpStatus: null, error: String(e?.message ?? e), fbtraceId: null, metaEventId: null, emqRaw: null };
  }
}

/**
 * Per-event "send status + match quality" for the CAPI send status screen.
 * G8: splits the sent rows into LIVE (actually POSTed to Meta) vs SIMULATED
 * (local mark, no pixel/token) so the UI never shows a simulate number as
 * live. `avgPurchaseMq` is computed from Meta-REPORTED EMQ only
 * (`emqFromMeta=true`) — a locally-estimated heuristic is a different animal
 * and is surfaced separately as `avgPurchaseMqEstimated`.
 */
export async function capiStatus(prisma: PrismaClient, clientId: string) {
  const rows = await prisma.outboundEvent.findMany({
    where: { clientId },
    orderBy: { eventTime: "desc" },
    take: 200,
  });
  const counts = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  let simulatedSent = 0;
  let liveSent = 0;
  for (const r of rows) {
    counts[r.status as keyof typeof counts]++;
    if (r.status === "sent") {
      if (r.simulated) simulatedSent++;
      else liveSent++;
    }
  }
  // Meta-reported EMQ on Purchase rows (the G8 acceptance number).
  const metaMq = rows.filter((r) => r.type === "Purchase" && r.emqFromMeta && r.matchQuality != null);
  const avgPurchaseMq = metaMq.length
    ? Math.round(metaMq.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / metaMq.length)
    : null;
  // Separately: locally-estimated EMQ on Purchase rows (NOT Meta's number).
  const estMq = rows.filter((r) => r.type === "Purchase" && !r.emqFromMeta && r.matchQuality != null);
  const avgPurchaseMqEstimated = estMq.length
    ? Math.round(estMq.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / estMq.length)
    : null;
  return {
    rows,
    counts,
    simulatedSent,
    liveSent,
    avgPurchaseMq, // Meta-reported only (null = no live Purchase EMQ yet)
    avgPurchaseMqEstimated,
  };
}
