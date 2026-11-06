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
  /** Base URL the inboundUrl is built from (default the app's base). */
  baseUrl?: string;
}

/**
 * Create a WebhookEndpoint (a webhook CONNECTION): a fresh random secret
 * (reversible-stored), and the exact inboundUrl the PO pastes into the
 * provider dashboard (…&conn=<this id>). Returns the plain secret ONCE.
 */
export async function createWebhookEndpoint(prisma: PrismaClient, args: CreateEndpointArgs) {
  if (!isPlatform(args.platform)) {
    throw new Error(`unknown platform '${String(args.platform)}'`);
  }
  const secret = generateWebhookSecret();
  const base = (args.baseUrl ?? process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
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

/** Soft revoke: active=false (not a delete — the connection log stays intact). */
export async function revokeWebhookEndpoint(prisma: PrismaClient, id: string): Promise<{ revoked: boolean }> {
  const ep = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!ep || !ep.active) return { revoked: false };
  await prisma.webhookEndpoint.update({ where: { id }, data: { active: false } });
  return { revoked: true };
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
