/**
 * D-15 — host-aware inboundUrl helpers (PURE: no node:crypto, no Prisma).
 *
 * These live in their own module so a CLIENT component (the integrations
 * panel) can use them without dragging `node:crypto` into the browser
 * bundle (the Next build hard-fails on a node: scheme in client code).
 * `src/lib/integrations.ts` re-exports them, so the server routes + tests
 * keep importing from the one place they always have.
 *
 * Quick-tunnel subdomains (PUBLIC_BASE_URL) ROTATE on every cloudflared
 * restart, so a stored WebhookEndpoint.inboundUrl can point at a DEAD
 * subdomain — the path (?client=…&conn=…), secret, and platform are all
 * stable; ONLY the host is stale. These helpers make that self-healing:
 *   - urlHost: the origin host embedded in a URL (null when unparseable).
 *   - rehostInboundUrl: rewrite ONLY the host+scheme of a stored inboundUrl,
 *     preserving the path (?client=…&conn=…) verbatim — idempotent.
 */

/** The origin host (with port) of an absolute URL, or null if unparseable. */
export function urlHost(u: string): string | null {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

/**
 * Rewrite ONLY the host (+ scheme) of a stored inboundUrl, keeping the path
 * and query (?client=…&conn=…) byte-for-byte. Idempotent: re-applying the
 * same host returns an equal string. Returns null when either input isn't a
 * parseable absolute URL (so a caller never silently mangles a URL).
 */
export function rehostInboundUrl(storedUrl: string, newBase: string): string | null {
  let s: URL, b: URL;
  try {
    s = new URL(storedUrl);
    b = new URL(newBase);
  } catch {
    return null;
  }
  const next = `${b.protocol}//${b.host}${s.pathname}${s.search}`;
  return next === storedUrl ? storedUrl : next;
}
