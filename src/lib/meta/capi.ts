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
import { buildCapiEvent, shouldSendPurchase } from "../capi";
import { CapiIdentity, CapiEventType } from "../types";

export interface SendOutcome {
  total: number;
  sent: number;
  failed: number;
  skipped: number; // already sent / refunded / no identity
  errors: string[];
}

/**
 * Send all queued CAPI events for a client to Meta.
 *
 * @param prisma
 * @param clientId
 * @param opts.metaAccessToken  real token -> live HTTP. Empty -> simulate
 *                               (mark sent, no network) so the demo works.
 * @param opts.metaPixelId       the pixel/dataset id (spec 5.8: per-client).
 */
export async function sendQueue(
  prisma: PrismaClient,
  clientId: string,
  opts: {
    metaAccessToken?: string;
    metaPixelId?: string | null;
    apiVersion?: string;
    now?: Date;
  } = {}
): Promise<SendOutcome> {
  const {
    metaAccessToken = process.env.META_ACCESS_TOKEN ?? "",
    metaPixelId = null,
    apiVersion = process.env.META_API_VERSION ?? "v23.0",
    now = new Date(),
  } = opts;

  // Queued (or failed, to retry) — never "sent" again (dedup rule, spec 5.8).
  const rows = await prisma.outboundEvent.findMany({
    where: { clientId, status: { in: ["queued", "failed"] } },
    include: { lead: true },
  });

  const out: SendOutcome = { total: rows.length, sent: 0, failed: 0, skipped: 0, errors: [] };
  if (rows.length === 0) return out;

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

    // Build the exact CAPI payload (hashed phone/email + fbc/fbp + value).
    const kind = row.type as CapiEventType;
    const payload = buildCapiEvent({
      kind,
      identity,
      value: row.type === "Purchase" || row.type === "Refund" ? row.value : null,
      currency: row.currency ?? "INR",
      eventTimeIso: row.eventTime.toISOString(),
      discriminator: row.dedupKey.includes(":") ? row.dedupKey.split(":").pop() : undefined,
      pixelId: metaPixelId,
    });

    if (metaAccessToken) {
      // Real send to Meta's Conversions API.
      try {
        const res = await fetch(
          `https://graph.facebook.com/${apiVersion}/` +
            (metaPixelId ?? "pixel") + `/events?access_token=${metaAccessToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: [payload] }),
          }
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          await prisma.outboundEvent.update({
            where: { id: row.id },
            data: { status: "failed", error: `${res.status} ${JSON.stringify(body).slice(0, 300)}` },
          });
          out.failed++;
          out.errors.push(`${row.dedupKey}: ${res.status}`);
          continue;
        }
        const mq = body.event_hub_log_view?.[0]?.event_match_quality ?? null;
        await prisma.outboundEvent.update({
          where: { id: row.id },
          data: {
            status: "sent",
            sentToMeta: true,
            matchQuality: typeof mq === "number" ? mq : row.matchQuality,
            sentAt: now,
          },
        });
        out.sent++;
      } catch (e: any) {
        await prisma.outboundEvent.update({
          where: { id: row.id },
          data: { status: "failed", error: String(e?.message ?? e) },
        });
        out.failed++;
        out.errors.push(`${row.dedupKey}: ${e?.message ?? e}`);
      }
    } else {
      // Simulated send (demo / tests / no token): mark as sent locally.
      await prisma.outboundEvent.update({
        where: { id: row.id },
        data: { status: "sent", sentToMeta: true, sentAt: now, error: null },
      });
      out.sent++;
    }
  }

  // Also mark any lead events sent (spec 5.8 shows status per event).
  await prisma.event.updateMany({
    where: { clientId, type: { in: ["registered", "webinar_joined", "call_booked", "payment_success"] }, sentToMeta: false },
    data: { sentToMeta: true },
  });

  return out;
}

/**
 * Per-event "send status + match quality" for the CAPI send status screen.
 */
export async function capiStatus(prisma: PrismaClient, clientId: string) {
  const rows = await prisma.outboundEvent.findMany({
    where: { clientId },
    orderBy: { eventTime: "desc" },
    take: 200,
  });
  const counts = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of rows) counts[r.status as keyof typeof counts]++;
  const avgMq = rows.filter((r) => r.matchQuality != null && r.type === "Purchase");
  const avgPurchaseMq = avgMq.length
    ? Math.round(avgMq.reduce((s, r) => s + (r.matchQuality ?? 0), 0) / avgMq.length)
    : null;
  return { rows, counts, avgPurchaseMq };
}
