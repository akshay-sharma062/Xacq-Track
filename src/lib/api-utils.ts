/**
 * Tiny helpers for the Next.js route handlers (spec 8: one codebase for the
 * team app, client portal and API routes). Keep routes thin; the real logic
 * lives in src/lib.
 */
import { prisma } from "./prisma";
import { currentUser, can, visibleClients, Session, Action } from "./session";

/**
 * Coerce an awaited `searchParams` (whose values can be `string | string[] |
 * undefined`) into a flat `Record<string, string | undefined>` using the first
 * value of each key. Server pages use this so query params type-check cleanly
 * instead of carrying the array union everywhere.
 */
export function qs(sp: { [k: string]: string | string[] | undefined }): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/** Resolve the acting session, or null when unauthenticated. */
export async function getSession(): Promise<Session | null> {
  return currentUser();
}

/**
 * Gate a route on a role-level permission. Returns the session when allowed,
 * or the exact error message to send when denied — routes translate that into
 * a 401/403 response.
 */
export async function gate(
  action: Action
): Promise<{ session: Session } | { error: string; status: 401 | 403 }> {
  const s = await currentUser();
  if (!s) return { error: "unauthenticated", status: 401 };
  if (!can(s, action)) return { error: `role '${s.role}' may not '${action}'`, status: 403 };
  return { session: s };
}

/**
 * Which client a request targets: an explicit `client` (query/body) wins if it
 * is in the session's visible set; otherwise the single visible client
 * (portal users), else the first. Returns null when there is nothing visible.
 * (spec 5.10: a client login sees only their own data.)
 */
export async function resolveClient(
  session: Session,
  requested?: string | null
): Promise<string | null> {
  const visible = await visibleClients(session);
  if (visible.length === 0) return null;
  if (requested && visible.includes(requested)) return requested;
  return visible.length === 1 ? visible[0] : visible[0] ?? null;
}

/**
 * Dashboard-V2 §1: "All spend-family reports + KPIs accept 'All' (no client /
 * adAccount param = all visible to the role)." Resolve the client SET a request
 * targets: an explicit `client` in the visible set → that one; "all" or no param
 * → the whole visible set (the aggregate view). The spend-family report route
 * aggregates across this set; per-client drill-down still passes a single id.
 */
export async function resolveClientSet(
  session: Session,
  requested?: string | null
): Promise<string[]> {
  const visible = await visibleClients(session);
  if (visible.length === 0) return [];
  if (requested && requested !== "all") return visible.includes(requested) ? [requested] : [];
  return visible; // "all" or absent → aggregate across everything visible
}

/** Quick webhook status counts for the integrations hub screen. */
export async function webhookStats(clientId?: string) {
  const where = { ...(clientId ? { clientId } : {}) };
  const [total, failed, duplicate] = await Promise.all([
    prisma.webhookLog.count({ where }),
    prisma.webhookLog.count({ where: { ...where, status: "failed" } }),
    prisma.webhookLog.count({ where: { ...where, status: "duplicate" } }),
  ]);
  return { total, failed, duplicate };
}
