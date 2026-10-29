/**
 * Security helpers (spec 10). These are the "not optional in any phase" rules
 * from the checklist, implemented as small pure helpers so the API routes stay
 * thin and every screen/API can enforce them consistently:
 *   - every inbound webhook verified by signature or shared secret BEFORE work;
 *   - rate limit on the public ingest API;
 *   - audit logging of exports + phone access;
 *   - phone/email masked for roles that don't need them.
 */
import { prisma } from "./prisma";
import type { Session } from "./session";

// ---------------------------------------------------------------------------
// Rate limiting (spec 10: "rate limits on the public ingest API").
// A tiny in-memory sliding window — enough to stop a bad actor flooding the
// ingest endpoint in a single-node demo; a multi-node prod would use Redis.
// ---------------------------------------------------------------------------
const WINDOW_MS = 60_000;
const counts = new Map<string, number[]>();

function limit(defaultPerMin = 120): number {
  const raw = process.env.INGEST_RATE_LIMIT_PER_MIN;
  return raw ? Number(raw) || defaultPerMin : defaultPerMin;
}

/**
 * Returns {ok, remaining} for a `key`. On overflow the caller should 429.
 * Keys are per client+platform so one noisy gateway can't starve others.
 */
export function rateLimit(key: string, perMin = limit()): { ok: boolean; remaining: number } {
  const now = Date.now();
  const hits = (counts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  const ok = hits.length < perMin;
  hits.push(now);
  counts.set(key, hits);
  // Opportunistic GC so the map doesn't grow unbounded.
  if (counts.size > 10_000) {
    for (const [k, arr] of counts) {
      if (arr.every((t) => now - t >= WINDOW_MS)) counts.delete(k);
    }
  }
  return { ok, remaining: Math.max(0, perMin - hits.length) };
}

/** Resolve which shared secret a client uses for a given platform. */
export async function clientSecretFor(clientId: string): Promise<string | null> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { webhookSecret: true } });
  return c?.webhookSecret ?? null;
}

// ---------------------------------------------------------------------------
// Audit log (spec 5.10 / 10: who viewed, exported or changed what).
// Every export is logged; phone access is logged for masked roles.
// ---------------------------------------------------------------------------
export async function auditExport(
  session: Session,
  clientId: string,
  entity: string,
  details: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      clientId,
      userId: session.userId,
      action: "export",
      entity,
      entityId: entity,
      details: JSON.stringify(details),
    },
  });
}

export async function auditAction(
  session: Session,
  clientId: string,
  action: string,
  entity: string,
  entityId: string,
  details?: Record<string, unknown>
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      clientId,
      userId: session.userId,
      action,
      entity,
      entityId,
      details: JSON.stringify(details ?? {}),
    },
  });
}
