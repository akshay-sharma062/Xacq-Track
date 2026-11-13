/**
 * D-13 — Webhook & API key management: multiple connections per
 * client×platform, hash-only key storage, per-connection webhook secrets.
 *
 * This module holds the security-critical pure/partially-pure helpers so the
 * admin API routes stay thin and every screen can reuse the same logic:
 *
 *   - API keys (ApiKey): a presented-key → hash → compare flow. The DB stores
 *     ONLY `keyHash` (SHA-256 of the random key string); the plain key is
 *     returned to the caller EXACTLY ONCE, at creation. After that it is gone
 *     (the hash is one-way). This is the security guardrail the ticket names.
 *
 *   - Webhook connections (WebhookEndpoint): each gets its OWN generated
 *     secret. D-13 DESIGN DECISION (recorded in DECISIONS.md): the secret is
 *     stored REVERSIBLY (plain in this dev build; KMS/encrypted at G10) —
 *     NOT a one-way hash — because the repo's HMAC gateways recompute an HMAC
 *     with the secret as the KEY. An HMAC can't be reproduced from a secret's
 *     SHA-256 hash, so hash-only storage would break every HMAC-gateway
 *     connection (the "two Razorpay test+prod" case this ticket exists for).
 *     "Shown exactly once" is therefore enforced at the API/UI layer: only the
 *     create response returns the plain value; list/GET/log endpoints never do.
 *
 *   - Connection log (WebhookConnectionLog): one row per received event,
 *     keyed to the endpoint, carrying the SHA-256 payload hash (dedup/audit)
 *     — NOT the raw payload (that still goes to the existing WebhookLog).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "./prisma";
import { SourcePlatform } from "./types";
import { urlHost, rehostInboundUrl } from "./webhookUrl";

// D-15: the two PURE host helpers live in ./webhookUrl (no node:crypto, no
// Prisma) so the CLIENT integrations panel can import them without dragging
// node: into the browser bundle. They are re-exported here so the server
// routes + tests keep their existing "@/lib/integrations" import.
export { urlHost, rehostInboundUrl };

// ---------------------------------------------------------------------------
// Hashing + generation (pure — unit-testable without a DB).
// ---------------------------------------------------------------------------

/** SHA-256 hex of a string (the stored form of an API key — never the plain). */
export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * A freshly-minted API key: a random 32-byte key, base64url-encoded with a
 * short `xacq_` prefix so it's recognisable, plus its SHA-256 hash (the value
 * the DB stores). The caller displays `plain` ONCE and discards it.
 */
export function generateApiKey(): { plain: string; keyHash: string } {
  const plain = "xacq_" + randomBytes(32).toString("base64url");
  return { plain, keyHash: sha256Hex(plain) };
}

/** Constant-time compare of a presented key against a stored SHA-256 hash. */
export function keyMatchesHash(plain: string, keyHash: string): boolean {
  const a = Buffer.from(sha256Hex(plain), "hex");
  const b = Buffer.from(keyHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A freshly-minted per-connection webhook secret: 32 random bytes, base64.
 * Stored REVERSIBLY on WebhookEndpoint.endpointSecret (see module note); the
 * plain value is returned to the caller ONCE, at creation.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64");
}

/** The platform keys the platform-dropdown + "enforced at write" use. */
export function isPlatform(p: unknown): p is SourcePlatform {
  const ok: SourcePlatform[] = [
    "meta", "aevent", "zoom", "tagmango", "razorpay", "cashfree",
    "cosmofeed", "flexifunnels", "calendly", "pabbly", "whatsapp", "xt", "sheets", "manual",
  ];
  return typeof p === "string" && ok.includes(p as SourcePlatform);
}

/** Map an IngestResult status onto the WebhookConnectionLog.status union. */
export function mapConnStatus(status: "processed" | "duplicate" | "failed" | "received"): "ok" | "duplicate" | "failed" {
  if (status === "failed") return "failed";
  if (status === "duplicate") return "duplicate";
  return "ok"; // "processed" | "received"
}

// ---------------------------------------------------------------------------
// API-key lifecycle (DB). Creation returns the plain key ONCE.
// ---------------------------------------------------------------------------

export interface CreateKeyArgs {
  label: string;
  clientId: string | null; // null = workspace-level admin key
  purpose: "ingest" | "api" | "webhook_verify";
  createdBy: string; // User id
}

/**
 * Create an ApiKey row, storing ONLY the SHA-256 hash. Returns the plain key
 * exactly once — the UI shows it with a "copy now, you won't see it again"
 * warning. The DB never holds the plain key.
 */
export async function createApiKey(prisma: PrismaClient, args: CreateKeyArgs) {
  const gen = generateApiKey();
  const row = await prisma.apiKey.create({
    data: {
      label: args.label,
      clientId: args.clientId,
      keyHash: gen.keyHash,
      purpose: args.purpose,
      createdBy: args.createdBy,
    },
  });
  return { id: row.id, label: row.label, clientId: row.clientId, purpose: row.purpose, key: gen.plain };
}

/** Idempotent revoke: sets revokedAt once; a second revoke is a no-op. */
export async function revokeApiKey(prisma: PrismaClient, id: string): Promise<{ revoked: boolean }> {
  const k = await prisma.apiKey.findUnique({ where: { id } });
  if (!k || k.revokedAt) return { revoked: false };
  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  return { revoked: true };
}

// ---------------------------------------------------------------------------
// Webhook-connection lifecycle (DB).
// ---------------------------------------------------------------------------

export interface CreateEndpointArgs {
  clientId: string;
  platform: SourcePlatform;
  label: string;
  createdBy: string;
  /**
   * Explicit base injection (tests / callers). When omitted, D-13a's
   * PUBLIC_BASE_URL precedence applies (resolveWebhookBase).
   */
  baseUrl?: string;
}

// ---------------------------------------------------------------------------
// D-13a — base-URL precedence for webhook inboundUrls.
//
// The bug this fixes: inboundUrl defaulted to "http://localhost:3000"
// whenever no base was configured — and .env had none — so every generated
// FlexiFunnels/Razorpay connection pointed at a host an EXTERNAL provider
// cannot reach (FlexiFunnels rejects localhost outright). The public base is
// its OWN key, PUBLIC_BASE_URL (the live tunnel host external webhooks hit),
// DISTINCT from the client-side NEXT_PUBLIC_BASE_URL (the browser's base).
// Precedence: explicit arg (tests) > PUBLIC_BASE_URL > NEXT_PUBLIC_BASE_URL
// > the localhost dev fallback.
// ---------------------------------------------------------------------------

export type WebhookBaseSource = "explicit" | "PUBLIC_BASE_URL" | "NEXT_PUBLIC_BASE_URL" | "localhost-dev";

/** The base + which tier supplied it (so the UI can honestly flag the
 *  localhost fallback as "unreachable by external providers"). */
/**
 * Resolve the base URL a webhook inboundUrl is built from (D-13a precedence).
 * `env` is the env view (tests pass a partial; the default is the live
 * process.env). Typed as Record<string, string | undefined> so BOTH process.env
 * and a test partial literal are assignable (a weak all-optional type would
 * reject process.env with TS2559).
 */
export function resolveWebhookBase(
  explicit?: string,
  env: Record<string, string | undefined> = process.env
): { base: string; source: WebhookBaseSource } {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim().replace(/\/+$/, "") : null);
  const e1 = clean(explicit);
  if (e1) return { base: e1, source: "explicit" };
  const e2 = clean(env.PUBLIC_BASE_URL);
  if (e2) return { base: e2, source: "PUBLIC_BASE_URL" };
  const e3 = clean(env.NEXT_PUBLIC_BASE_URL);
  if (e3) return { base: e3, source: "NEXT_PUBLIC_BASE_URL" };
  return { base: "http://localhost:3000", source: "localhost-dev" };
}

/**
 * True when a base URL is a loopback host an EXTERNAL provider can never
 * reach — the exact D-13a failure mode. Drives the UI warning banner; the
 * refresh script logs it (and still rewrites — a loopback source means
 * PUBLIC_BASE_URL is simply unset yet).
 */
export function isLoopbackBase(url: string): boolean {
  try {
    // URL.hostname keeps IPv6 brackets ("[::1]") — strip them before the
    // comparison so http://[::1]:3000 is caught too.
    const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return false; // an unparseable value is a different (bannered-by-source) case
  }
}

/**
 * Create a WebhookEndpoint (a webhook CONNECTION): a fresh random secret
 * (reversible-stored), and the exact inboundUrl the PO pastes into the
 * provider dashboard (…&conn=<this id>). Returns the plain secret ONCE.
 * The base follows D-13a's PUBLIC_BASE_URL precedence (resolveWebhookBase).
 */
export async function createWebhookEndpoint(prisma: PrismaClient, args: CreateEndpointArgs) {
  if (!isPlatform(args.platform)) {
    throw new Error(`unknown platform '${String(args.platform)}'`);
  }
  const secret = generateWebhookSecret();
  const { base } = resolveWebhookBase(args.baseUrl);
  const row = await prisma.webhookEndpoint.create({
    data: {
      clientId: args.clientId,
      platform: args.platform,
      label: args.label,
      endpointSecret: secret, // reversible (KMS at G10); shown once, via this return
      // inboundUrl is completed after the id is known (the URL carries &conn=<id>).
      inboundUrl: `${base}/api/webhooks/${args.platform}?client=${args.clientId}&conn=`,
      createdBy: args.createdBy, // required FK -> User (who minted the connection)
    },
  });
  const inboundUrl = `${base}/api/webhooks/${row.platform}?client=${row.clientId}&conn=${row.id}`;
  await prisma.webhookEndpoint.update({ where: { id: row.id }, data: { inboundUrl } });
  return { id: row.id, platform: row.platform, label: row.label, clientId: row.clientId, inboundUrl, secret };
}

// ---------------------------------------------------------------------------
// D-15 — webhook connection: HARD delete.
//
// PO request ("revoke karne par delete hi ho jaye"): revoke is now a real
// delete. Safety model (the ticket's rules, recorded in DECISIONS D-15):
//   - WebhookConnectionLog.endpoint is `onDelete: Cascade` in the schema, so
//     deleting an endpoint takes its connection-level log rows with it (they
//     are THIS connection's trail).
//   - The RAW-received-payload `WebhookLog` rows are client-scoped audit of
//     what actually arrived and carry NO endpoint relation — they are NOT
//     cascade-deleted here (a heavier, explicit delete is a separate PO
//     decision, never folded in silently).
//   - The DELETE route writes an AuditLog row BEFORE the delete (actor,
//     target endpoint id/platform/label, action "delete_webhookEndpoint"),
//     so the audit trail outlives the row. Audit details carry platform +
//     label only — NEVER the endpointSecret.
//   - ApiKey revoke stays SOFT (revokedAt stamp) unless the PO explicitly
//     asks for hard-deleting keys (D-15 default, recorded).
// ---------------------------------------------------------------------------

/**
 * D-15: hard-delete a webhook CONNECTION (the row + its cascaded connLogs;
 * the raw WebhookLog rows are untouched). Unknown id → { deleted:false }
 * (the route maps that to a clean 404, never a 500).
 */
export async function deleteWebhookEndpoint(prisma: PrismaClient, id: string): Promise<{ deleted: boolean }> {
  const ep = await prisma.webhookEndpoint.findUnique({ where: { id }, select: { id: true } });
  if (!ep) return { deleted: false };
  // connLogs cascade on delete (schema onDelete: Cascade); WebhookLog rows
  // have no endpoint relation and stay (client-scoped raw-received audit).
  await prisma.webhookEndpoint.delete({ where: { id } });
  return { deleted: true };
}

// ---------------------------------------------------------------------------
// D-13a — one-off refresh of EXISTING connections' inboundUrl.
//
// Connections created before PUBLIC_BASE_URL existed (or while it was unset)
// carry a localhost inboundUrl in the DB — external providers reject that.
// This rewrites ONLY the inboundUrl string on every ACTIVE row (revoked
// connections are dead — their past URL is part of the audit trail; the PO
// mints a fresh connection for any re-pointing need), leaving
// endpointSecret / keyHash / the connection log entirely untouched.
// Idempotent: a second run finds every URL already correct → 0 changes.
// ---------------------------------------------------------------------------

export interface WebhookInboundUrl {
  /** `<base>/api/webhooks/<platform>?client=<clientId>&conn=<id>`. */
  url: string;
  source: WebhookBaseSource;
}

/** Rebuild one connection's inboundUrl against a base (+tier). */
export function buildInboundUrl(
  ep: { id: string; platform: string; clientId: string },
  base: string,
  source: WebhookBaseSource
): WebhookInboundUrl {
  return { url: `${base}/api/webhooks/${ep.platform}?client=${ep.clientId}&conn=${ep.id}`, source };
}

// ---------------------------------------------------------------------------
// D-15 — host-aware inboundUrl handling.
//
// Quick-tunnel subdomains (PUBLIC_BASE_URL) ROTATE on every cloudflared
// restart, so a stored WebhookEndpoint.inboundUrl can point at a DEAD
// subdomain — the path (?client=…&conn=…), secret, and platform are all
// stable; ONLY the host is stale. These helpers make that self-healing:
//   - urlHost / rehostInboundUrl: the two PURE host helpers, re-exported
//     from ./webhookUrl (imported above) so the CLIENT panel can use them
//     without dragging node: into the browser bundle.
//   - currentWebhookHost: the "current live host" KNOWN SOURCE — the
//     PO-persisted Workspace.liveHost (set by the Refresh action) wins, else
//     the .env PUBLIC_BASE_URL (D-13a precedence).
// The admin list compares each stored URL's host to this known source and
// surfaces a "URL is stale (host X ≠ current Y)" badge; it does NOT
// auto-refresh on every load (a rotation is a PO event, not a background
// write) — the PO clicks "Refresh URLs" to re-point.
// ---------------------------------------------------------------------------

/**
 * D-15: the "current live host" a webhook inboundUrl should point at. The
 * PO-persisted `Workspace.liveHost` (written by the Refresh action) wins;
 * otherwise fall back to the .env base (D-13a precedence). Returns the
 * resolved base + which source supplied it.
 */
export async function currentWebhookHost(
  prisma: PrismaClient,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): Promise<{ base: string; source: "workspace.liveHost" | WebhookBaseSource }> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { liveHost: true } });
  const persisted = ws?.liveHost?.trim();
  if (persisted && persisted.length) {
    return { base: persisted.replace(/\/+$/, ""), source: "workspace.liveHost" };
  }
  const r = resolveWebhookBase(undefined, env);
  return { base: r.base, source: r.source };
}

export interface RefreshWebhookUrlsResult {
  base: string;
  source: WebhookBaseSource;
  /** loopback base — external providers can't reach it; the UI banners it. */
  baseIsLoopback: boolean;
  /** every ACTIVE row touched; `changed=false` = already current. */
  rows: { id: string; label: string; platform: string; active: boolean; changed: boolean; before: string; after: string }[];
  updated: number; // changed=true count
  unchanged: number; // changed=false count
}

export async function refreshWebhookInboundUrls(
  prisma: PrismaClient,
  opts: { explicitBase?: string } = {}
): Promise<RefreshWebhookUrlsResult> {
  const { base, source } = resolveWebhookBase(opts.explicitBase);
  // ACTIVE rows only (the ticket's scope): a revoked connection is dead — its
  // stored URL is audit trail, and re-pointing it would hide the fact it was
  // revoked while localhost-based. A PO re-mints a connection instead.
  const rows = await prisma.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, clientId: true, platform: true, label: true, active: true, inboundUrl: true },
    orderBy: { createdAt: "asc" },
  });
  let updated = 0;
  let unchanged = 0;
  const out: RefreshWebhookUrlsResult["rows"] = [];
  for (const ep of rows) {
    const next = buildInboundUrl(ep, base, source);
    const changed = ep.inboundUrl !== next.url;
    if (changed) {
      // ONLY the URL string is written — the secret, hash and log are never
      // read or touched here (the ticket's hard constraint).
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { inboundUrl: next.url } });
      updated++;
    } else {
      unchanged++;
    }
    out.push({ id: ep.id, label: ep.label, platform: ep.platform, active: ep.active, changed, before: ep.inboundUrl, after: next.url });
  }
  return { base, source, baseIsLoopback: isLoopbackBase(base), rows: out, updated, unchanged };
}

/**
 * D-15: re-point every ACTIVE connection's inboundUrl to `host` by rewriting
 * ONLY the host substring (path + ?client=&conn= + secret untouched). The
 * host argument is the "current live host" (Workspace.liveHost ?? the .env
 * base, via currentWebhookHost). Idempotent: a second run with the same
 * host changes 0 rows.
 */
export interface RefreshToHostRow {
  id: string;
  /** The connection's client — the refresh route's per-row audit is client-scoped. */
  clientId: string;
  label: string;
  platform: string;
  changed: boolean;
  before: string;
  after: string;
}

export interface RefreshToHostResult {
  host: string;
  updated: number;
  unchanged: number;
  rows: RefreshToHostRow[];
}

export async function refreshWebhookUrlsToHost(
  prisma: PrismaClient,
  host: string
): Promise<RefreshToHostResult> {
  const base = host.trim().replace(/\/+$/, "");
  const rows = await prisma.webhookEndpoint.findMany({
    where: { active: true },
    select: { id: true, clientId: true, platform: true, label: true, inboundUrl: true },
    orderBy: { createdAt: "asc" },
  });
  let updated = 0;
  let unchanged = 0;
  const out: RefreshToHostRow[] = [];
  for (const ep of rows) {
    // Only the host substring changes: keep the stored path + query
    // (?client=&conn=) byte-for-byte. Falls back to rebuilding the URL from
    // the row's fields when the stored value isn't a parseable absolute URL
    // (defensive — it then still lands on the correct host).
    const next = rehostInboundUrl(ep.inboundUrl, base) ?? buildInboundUrl(ep, base, "explicit").url;
    const changed = next !== ep.inboundUrl;
    if (changed) {
      // ONLY the URL string is written — the id, client, platform and the
      // endpointSecret are never read or touched (the ticket's hard rule).
      await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { inboundUrl: next } });
      updated++;
    } else {
      unchanged++;
    }
    out.push({ id: ep.id, clientId: ep.clientId, label: ep.label, platform: ep.platform, changed, before: ep.inboundUrl, after: next });
  }
  return { host: base, updated, unchanged, rows: out };
}

/**
 * Resolve an `&conn=<id>` to a usable, matching endpoint for a route: active,
 * and belonging to the same client + platform as the request. A bad/revoked
 * id returns null (the route maps that to 404 "unknown connection").
 */
export async function resolveEndpointForRoute(
  prisma: PrismaClient,
  connId: string,
  clientId: string,
  platform: SourcePlatform
): Promise<import("@prisma/client").WebhookEndpoint | null> {
  const ep = await prisma.webhookEndpoint.findUnique({ where: { id: connId } });
  if (!ep || !ep.active) return null;
  if (ep.clientId !== clientId || ep.platform !== platform) return null;
  return ep;
}

/** Record one connection-log row (SHA-256 payload hash, not the raw body). */
export async function recordConnectionLog(
  prisma: PrismaClient,
  endpointId: string,
  args: { status: "ok" | "failed" | "duplicate"; error?: string | null; payloadHash: string }
): Promise<void> {
  await prisma.webhookConnectionLog.create({
    data: {
      endpointId,
      status: args.status,
      error: args.error ?? null,
      payloadHash: args.payloadHash,
    },
  });
}
