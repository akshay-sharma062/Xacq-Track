/**
 * D-17 — self-capturing public host.
 *
 * The recurring bug this fixes: the quick-tunnel subdomain ROTATES on every
 * cloudflared restart, so webhook/tracker/xt.js URLs generated from a stale
 * .env PUBLIC_BASE_URL 404 at the provider ("FlexiFunnels says incorrect
 * URL"). D-15 made the PO re-point manually (Workspace.liveHost + a Refresh
 * button). D-17 makes the host SELF-CAPTURING: whenever an inbound request
 * arrives whose Host header is the live quick-tunnel subdomain, the app
 * records it — no daily manual work.
 *
 * Two parts:
 *   1. noteLiveHost(req) — the CAPTURE. Idempotent (writes only when the host
 *      VALUE changed, never a write storm), fire-and-forget (callers do
 *      `void noteLiveHost(req)`; it never blocks or throws), guarded
 *      (localhost / 127.0.0.1 / ::1 Hosts NEVER write; a STALE capture —
 *      timestamped older than the stored liveHostSeenAt — never clobbers a
 *      FRESHER one; the guard is a single conditional UPDATE, no lock, and
 *      never runs inside another write transaction).
 *   2. currentPublicBase() / pickPublicBase() — the SOURCE OF TRUTH every
 *      generator (webhook inboundUrls, the D-15 refresh/quick-action blocks,
 *      tracker.js install snippets, xt.js snippet docs) resolves against:
 *        Workspace.liveHost (if liveHostSeenAt is fresh, <24h; a pre-D-17
 *        row with NO stamp was PO-persisted by D-15, so it is trusted)
 *        > PUBLIC_BASE_URL (.env)
 *        > NEXT_PUBLIC_BASE_URL (.env)
 *        > localhost-dev fallback
 *
 * A single helper so no generator hardcodes a host (G10 swaps the tunnel
 * for a Vercel domain: set PUBLIC_BASE_URL, or let the capture family-match
 * the configured host — no code change).
 */
import { prisma as defaultPrisma, PrismaClient } from "./prisma";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type PublicBaseSource =
  | "workspace.liveHost"
  | "PUBLIC_BASE_URL"
  | "NEXT_PUBLIC_BASE_URL"
  | "localhost-dev";

/** A liveHost capture is trusted by currentPublicBase() for 24h. */
export const LIVE_HOST_TTL_MS = 24 * 60 * 60 * 1000;
/** The admin panel badges "host may be stale" after 2h without a capture. */
export const LIVE_HOST_STALE_BADGE_MS = 2 * 60 * 60 * 1000;

export interface PublicBaseResolution {
  base: string;
  source: PublicBaseSource;
  liveHost: string | null;
  liveHostSeenAt: Date | null;
  /** liveHost is present AND fresh (< TTL, or an un-stamped D-15 value). */
  liveHostFresh: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a DB)
// ---------------------------------------------------------------------------

function cleanBase(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim().replace(/\/+$/, "");
  if (!t) return null;
  // Normalise to the ORIGIN (scheme://host[:port]): the base every URL
  // generator builds from (<base>/tracker.js, <base>/xt.js, <base>/api/…).
  // The D-15 PO-persisted liveHost can carry a PATH (it stores the URL the
  // last Refresh visited, e.g. "…/admin/integrations") — a path must never
  // leak into a generated snippet/inbound URL.
  if (/^https?:\/\//i.test(t)) {
    try {
      return new URL(t).origin;
    } catch {
      return t; // unparseable — keep it verbatim (the caller validates elsewhere)
    }
  }
  return t;
}

/** The lowercased hostname of a base URL (null when unparseable/absent). */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "loopback"]);

/**
 * Is this Host-header value capturable as the live public host?
 *   - a quick-tunnel subdomain (*.trycloudflare.com), or
 *   - the CONFIGURED public-host family (same hostname as .env
 *     PUBLIC_BASE_URL / the persisted liveHost — e.g. the G10 Vercel
 *     domain, so the swap needs no code change).
 * Loopback hosts (localhost / 127.0.0.1 / ::1) NEVER capture — a local
 * request must not write itself as the public host (the ticket's guard).
 */
export function isCapturableHost(
  hostHeader: string | null | undefined,
  ctx: { publicBaseUrl?: string | null; liveHost?: string | null } = {}
): boolean {
  const raw = String(hostHeader ?? "").trim().toLowerCase();
  if (!raw) return false;
  const bare = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""); // drop :port / [v6] brackets
  if (LOOPBACK_HOSTS.has(bare)) return false;
  if (bare.endsWith(".trycloudflare.com")) return true;
  if (ctx.publicBaseUrl && hostOf(ctx.publicBaseUrl) === bare) return true;
  if (ctx.liveHost && hostOf(ctx.liveHost) === bare) return true;
  return false;
}

/**
 * Rebuild the public base URL (scheme://host[:port]) from a capturable Host
 * header. If the host is the configured family, the configured base's
 * scheme/port are preserved; a plain quick-tunnel subdomain is https.
 * Returns null when the host is not capturable.
 */
export function baseFromHostHeader(
  hostHeader: string | null | undefined,
  ctx: { publicBaseUrl?: string | null; liveHost?: string | null } = {}
): string | null {
  const raw = String(hostHeader ?? "").trim();
  if (!isCapturableHost(raw, ctx)) return null;
  const bare = raw.toLowerCase().replace(/:\d+$/, "");
  for (const configured of [ctx.publicBaseUrl ?? null, ctx.liveHost ?? null]) {
    if (hostOf(configured) === bare) {
      const c = cleanBase(configured);
      if (c) return c; // keep the configured scheme/port exactly
    }
  }
  return `https://${raw}`;
}

/**
 * The PURE source-of-truth resolution (the ticket's precedence, testable
 * without a DB):
 *   Workspace.liveHost (fresh: liveHostSeenAt < TTL; an UNSTAMPED liveHost is
 *   a D-15 PO-persisted value and is trusted)
 *   > PUBLIC_BASE_URL (.env) > NEXT_PUBLIC_BASE_URL (.env) > localhost-dev.
 * `ttlMs` is injectable so "fresh" is deterministic in tests.
 */
export function pickPublicBase(input: {
  liveHost: string | null;
  liveHostSeenAt: Date | null;
  now: Date;
  env: Record<string, string | undefined>;
  ttlMs?: number;
}): PublicBaseResolution {
  const { liveHost, liveHostSeenAt, now, env, ttlMs = LIVE_HOST_TTL_MS } = input;
  const persisted = cleanBase(liveHost);
  const fresh =
    persisted !== null &&
    (liveHostSeenAt === null || now.getTime() - liveHostSeenAt.getTime() < ttlMs);
  if (fresh) {
    return { base: persisted!, source: "workspace.liveHost", liveHost: persisted, liveHostSeenAt, liveHostFresh: true };
  }
  // Stale (> TTL) or absent liveHost → the .env tiers (D-13a precedence).
  const p = cleanBase(env.PUBLIC_BASE_URL);
  if (p) {
    return { base: p, source: "PUBLIC_BASE_URL", liveHost: persisted, liveHostSeenAt, liveHostFresh: false };
  }
  const n = cleanBase(env.NEXT_PUBLIC_BASE_URL);
  if (n) {
    return { base: n, source: "NEXT_PUBLIC_BASE_URL", liveHost: persisted, liveHostSeenAt, liveHostFresh: false };
  }
  // The localhost fallback is the D-13a value, repeated here so this module
  // stays self-contained (no circular import of integrations.ts).
  return { base: "http://localhost:3000", source: "localhost-dev", liveHost: persisted, liveHostSeenAt, liveHostFresh: false };
}

/**
 * D-17: the current public base — every URL generator resolves this, never a
 * hardcoded host. Reads the agency Workspace row (or `workspaceId` when
 * given) and applies the ticket's precedence.
 */
export async function currentPublicBase(
  opts: {
    prisma?: PrismaClient;
    workspaceId?: string;
    env?: Record<string, string | undefined>;
    now?: Date;
  } = {}
): Promise<PublicBaseResolution> {
  const prisma = opts.prisma ?? defaultPrisma;
  const ws = opts.workspaceId
    ? await prisma.workspace.findUnique({ where: { id: opts.workspaceId }, select: { liveHost: true, liveHostSeenAt: true } })
    : await prisma.workspace.findFirst({ select: { liveHost: true, liveHostSeenAt: true } });
  return pickPublicBase({
    liveHost: ws?.liveHost ?? null,
    liveHostSeenAt: ws?.liveHostSeenAt ?? null,
    now: opts.now ?? new Date(),
    env: opts.env ?? process.env,
  });
}

// ---------------------------------------------------------------------------
// The capture (part 1)
// ---------------------------------------------------------------------------

export interface NoteLiveHostResult {
  captured: boolean;
  host: string | null;
  reason?: "capturable" | "unchanged" | "stale-capture" | "not-capturable" | "no-workspace" | "error";
}

/**
 * D-17: record the request's Host header as the live public host.
 *
 *  - Idempotent: when the stored liveHost already equals the captured base
 *    this is a NO-OP (no write storm on high-traffic routes).
 *  - Stale-clobber guard: a capture whose timestamp is NOT newer than the
 *    stored liveHostSeenAt never overwrites a fresher value (the single
 *    conditional UPDATE below is the guard — atomic, no lock, and never
 *    invoked inside another write transaction).
 *  - Fire-and-forget: the helper NEVER throws; callers do `void
 *    noteLiveHost(req)` so a request is never blocked on the write.
 *  - localhost / 127.0.0.1 / ::1 Hosts never write (the guard).
 *
 * `now`/`prisma`/`env` are injectable for tests.
 */
/**
 * The header view noteLiveHost reads — a `get(name)` that returns the Host
 * header. Satisfied by a NextRequest (`req.headers`, a `Headers`) and by
 * next/headers' `ReadonlyHeaders` (a server-component page render), so the
 * SAME capture call works from a route handler OR the root page.
 */
type HeaderGetter = { get(name: string): string | null };

export async function noteLiveHost(
  req: { headers: HeaderGetter },
  opts: {
    now?: Date;
    prisma?: PrismaClient;
    env?: Record<string, string | undefined>;
    workspaceId?: string;
  } = {}
): Promise<NoteLiveHostResult> {
  try {
    const prisma = opts.prisma ?? defaultPrisma;
    const now = opts.now ?? new Date();
    const env = opts.env ?? process.env;

    const hostHeader = req.headers.get("host");
    if (!hostHeader) return { captured: false, host: null, reason: "not-capturable" };

    // Cheap pre-check (NO DB read): a Host that is neither a quick-tunnel
    // subdomain nor the .env-configured public family is not capturable — and
    // that is the dev-time majority (localhost / 127.0.0.1), so skipping the
    // Workspace read here keeps high-traffic routes from doing a no-op DB hit
    // on every request. The full configured-family check (against the
    // persisted liveHost, for a G10 Vercel domain not yet in .env) still runs
    // after the read, below.
    if (!isCapturableHost(hostHeader, { publicBaseUrl: env.PUBLIC_BASE_URL })) {
      return { captured: false, host: null, reason: "not-capturable" };
    }

    // The agency Workspace row is the single capture target (the schema's
    // comment: one row, the agency workspace). A bare/empty DB is a no-op.
    const ws = opts.workspaceId
      ? await prisma.workspace.findUnique({ where: { id: opts.workspaceId }, select: { id: true, liveHost: true, liveHostSeenAt: true } })
      : await prisma.workspace.findFirst({ select: { id: true, liveHost: true, liveHostSeenAt: true } });
    if (!ws) return { captured: false, host: null, reason: "no-workspace" };

    const ctx = { publicBaseUrl: env.PUBLIC_BASE_URL ?? null, liveHost: ws.liveHost };
    const base = baseFromHostHeader(hostHeader, ctx);
    if (!base) return { captured: false, host: null, reason: "not-capturable" };
    if (ws.liveHost === base) return { captured: false, host: base, reason: "unchanged" };
    // Stale-clobber guard (ticket): a capture older than the stored
    // liveHostSeenAt never overwrites a fresher value.
    if (ws.liveHostSeenAt && ws.liveHostSeenAt.getTime() >= now.getTime()) {
      return { captured: false, host: base, reason: "stale-capture" };
    }

    // One conditional UPDATE = the idempotency + stale guards atomically:
    // write only when the value actually changed AND the existing capture
    // stamp is not newer than this one. A second identical request matches
    // nothing → 0 rows, no write. No $transaction, no lock.
    const res = await prisma.workspace.updateMany({
      where: {
        id: ws.id,
        AND: [
          { OR: [{ liveHost: { not: base } }, { liveHost: null }] }, // value actually changed
          { OR: [{ liveHostSeenAt: null }, { liveHostSeenAt: { lt: now } }] }, // not clobbering a fresher capture
        ],
      },
      data: { liveHost: base, liveHostSeenAt: now },
    });
    if (res.count > 0) return { captured: true, host: base, reason: "capturable" };
    // A concurrent capture between the read and the update won the race.
    return { captured: false, host: base, reason: "stale-capture" };
  } catch {
    // Fire-and-forget by contract: a capture failure never surfaces to the
    // request path (the host just stays at its last known value).
    return { captured: false, host: null, reason: "error" };
  }
}
