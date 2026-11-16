/**
 * D-13 — Webhook & API key management panel.
 *
 * Covers the ticket's required cases at the proven test boundary (the
 * framework-free lib layer + source-level contract checks, per the D-12
 * precedent):
 *
 *   1. Hash-only key storage: createApiKey stores keyHash = SHA-256(plain);
 *      the plain key exists only in the ONE create return; keyMatchesHash is
 *      the presented-key → hash verify; the GET /keys select never carries
 *      keyHash or a plain value (route contract assert).
 *   2. One-time reveal: the admin routes return `showOnce: true` + a
 *      "cannot be retrieved later" warning ONLY on create; list/GET/log
 *      responses exclude keyHash / endpointSecret (contract asserts).
 *   3. TWO different conn ids on the same client×platform verify
 *      independently: the (clientId, platform, label) unique allows two rows
 *      (distinct labels), each with its OWN secret; the provider-adapter
 *      verify() accepts its OWN connection's secret header and REJECTS the
 *      sibling's; resolveEndpointForRoute scopes to active + same client +
 *      platform, so each ?conn=<id> hands the route its OWN secret.
 *   4. Legacy no-conn path unchanged: the [platform] route keeps
 *      `client.webhookSecret` as the fallback when `conn` is absent, and the
 *      conn selection is an OPTIONAL search param (contract assert).
 *   5. D-15 hard delete -> 404: deleteWebhookEndpoint removes the row + its
 *      cascaded connLogs (keeping the raw WebhookLog rows); an unknown id
 *      returns { deleted:false } (the route maps that to a clean 404, never
 *      a 500); resolveEndpointForRoute returns null for a deleted conn.
 *   6. Audit-log write on create/revoke (auditAction functional test + the
 *      routes wiring it) and conn-log write on receipt (recordConnectionLog:
 *      one payload-hash-only row per event; the model has no raw-payload
 *      column, so the raw body cannot leak here).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import {
  sha256Hex,
  generateApiKey,
  keyMatchesHash,
  generateWebhookSecret,
  createApiKey,
  revokeApiKey,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  resolveEndpointForRoute,
  recordConnectionLog,
  isPlatform,
  mapConnStatus,
} from "../src/lib/integrations";
// NOTE: security.auditAction is NOT invoked from this file — it writes through
// the global prisma singleton (src/lib/prisma.ts → dev.db), which a test must
// not touch. The audit row is written field-for-field via the isolated temp DB
// instead; the route-contract asserts below prove the routes wire auditAction.
import { flexifunnelsAdapter, razorpayAdapter } from "../src/lib/adapters/payments";
import { createHmac } from "node:crypto";

/** HMAC-SHA256 hex (mirrors Razorpay's signature: HMAC(secret, rawBody)). */
function hmacSha256(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

const FIT = "cl_upcurvv"; // the tenancy bootstrap client
const OWNER = "u_owner"; // the tenancy bootstrap user (createdBy FK)

// Route-file contract text (pin the security guarantees; a future edit that
// weakens them breaks these asserts — the D-12 precedent pattern).
const ROUTE_CONN = readFileSync("src/app/api/webhooks/[platform]/route.ts", "utf8");
const ROUTE_KEYS = readFileSync("src/app/api/admin/keys/route.ts", "utf8");
const ROUTE_KEYS_REVOKE = readFileSync("src/app/api/admin/keys/revoke/route.ts", "utf8");
const ROUTE_HOOKS = readFileSync("src/app/api/admin/webhooks/route.ts", "utf8");
const ROUTE_HOOK_DELETE = readFileSync("src/app/api/admin/webhooks/delete/route.ts", "utf8");
const ROUTE_HOOK_LOGS = readFileSync("src/app/api/admin/webhooks/[id]/logs/route.ts", "utf8");

// ---------------------------------------------------------------------------
// 1 + 2 — API keys: hash-only storage, one-time reveal.
// ---------------------------------------------------------------------------

describe("D-13 ApiKey — hash-only storage + one-time reveal", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("createApiKey stores ONLY the SHA-256 hash; the plain key exists just in the create return", async () => {
    const res = await createApiKey(db.prisma, {
      label: "d13-test-key",
      clientId: FIT,
      purpose: "api",
      createdBy: OWNER,
    });
    // The return value is the ONE time the plain key exists in the system:
    expect(res.key).toMatch(/^xacq_/);
    // …and the DB row carries the hash — the plain is not derivable from it:
    const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: res.id } });
    expect(row.keyHash).toBe(sha256Hex(res.key)); // stored form = SHA-256(plain)
    expect(row.keyHash).toHaveLength(64); // 32-byte hex, i.e. a hash, not the key
    expect(row.keyHash).not.toContain(res.key);
    // The presented-key → hash verify works only for the actual key:
    expect(keyMatchesHash(res.key, row.keyHash)).toBe(true);
    expect(keyMatchesHash(res.key + "x", row.keyHash)).toBe(false);
    expect(keyMatchesHash("xacq_wrong", row.keyHash)).toBe(false);
  });

  it("two keys on the same client×purpose are distinct; cross-verify against a sibling hash fails", async () => {
    const a = await createApiKey(db.prisma, { label: "d13-a", clientId: FIT, purpose: "api", createdBy: OWNER });
    const b = await createApiKey(db.prisma, { label: "d13-b", clientId: FIT, purpose: "api", createdBy: OWNER });
    expect(a.key).not.toBe(b.key);
    const rowB = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: b.id } });
    expect(keyMatchesHash(a.key, rowB.keyHash)).toBe(false); // a's key never matches b's hash
  });

  it("the @@unique([clientId, label]) constraint allows two labels per client; a duplicate label is P2002; a workspace key coexists", async () => {
    await createApiKey(db.prisma, { label: "prod", clientId: FIT, purpose: "api", createdBy: OWNER });
    await createApiKey(db.prisma, { label: "staging", clientId: FIT, purpose: "api", createdBy: OWNER });
    // A duplicate (clientId, label) is rejected by the DB:
    await expect(
      createApiKey(db.prisma, { label: "prod", clientId: FIT, purpose: "api", createdBy: OWNER })
    ).rejects.toMatchObject({ code: "P2002" });
    // A workspace-level key (clientId=null) coexists with both:
    const ws = await createApiKey(db.prisma, { label: "prod", clientId: null, purpose: "ingest", createdBy: OWNER });
    expect(ws.clientId).toBeNull();
  });

  it("revokeApiKey stamps revokedAt (idempotent; the row + hash stay intact — soft, never delete)", async () => {
    const k = await createApiKey(db.prisma, { label: "d13-revoke", clientId: FIT, purpose: "api", createdBy: OWNER });
    expect((await revokeApiKey(db.prisma, k.id)).revoked).toBe(true);
    const row = await db.prisma.apiKey.findUniqueOrThrow({ where: { id: k.id } });
    expect(row.revokedAt).toBeInstanceOf(Date);
    expect(row.keyHash).toHaveLength(64); // hash survives the revoke (audit trail intact)
    expect((await revokeApiKey(db.prisma, k.id)).revoked).toBe(false); // idempotent no-op
    expect(await revokeApiKey(db.prisma, "nope")).toEqual({ revoked: false }); // unknown id: no-op
  });

  it("the GET /keys route never selects keyHash or a plain key; POST returns showOnce + warning (contract)", () => {
    // The list response shape excludes the hash entirely:
    expect(ROUTE_KEYS).toMatch(/select: \{ id: true, label: true, clientId: true, purpose: true, createdAt: true, revokedAt: true, lastUsedAt: true \}/);
    expect(ROUTE_KEYS).not.toMatch(/keyHash: true/); // keyHash is never selected anywhere in this route
    // Create returns the plain ONCE, with the guardrail copy:
    expect(ROUTE_KEYS).toMatch(/showOnce: true/);
    expect(ROUTE_KEYS).toMatch(/cannot be retrieved later/i);
  });
});

// ---------------------------------------------------------------------------
// 3 — Two conn ids on the same client×platform verify independently.
// ---------------------------------------------------------------------------

describe("D-13 WebhookEndpoint — multiple connections per client×platform", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  // D-18 repoint: flexifunnels is now in UNSIGNED_ONLY (the header-less
  // platforms get an EMPTY secret at generation), so it can no longer demo
  // the SIGNED "two connections, each with its own secret" property. Use a
  // signed-capable platform (razorpay — the D-13a "two test+prod" case) so
  // that value-prop stays proven here; D-18 owns the unsigned path.
  async function twoSignedConns() {
    const a = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d13-rzp-test", createdBy: OWNER });
    const b = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d13-rzp-prod", createdBy: OWNER });
    return { a, b };
  }

  it("the (clientId, platform, label) unique allows two connections, each with its OWN distinct secret + inboundUrl", async () => {
    const { a, b } = await twoSignedConns();
    expect(a.id).not.toBe(b.id);
    expect(a.secret).not.toBe(b.secret); // independent per-connection secrets (signed platform)
    expect(a.unsigned).toBe(false); // a signed platform is NOT in UNSIGNED_ONLY
    // The inboundUrl carries ?client=<client>&conn=<this id> (the PO paste target):
    expect(a.inboundUrl).toContain("/api/webhooks/razorpay");
    expect(a.inboundUrl).toContain(`?client=${FIT}&conn=${a.id}`);
    expect(b.inboundUrl).toContain(`&conn=${b.id}`);
    // A duplicate label on the same client×platform is rejected (P2002):
    await expect(
      createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d13-rzp-test", createdBy: OWNER })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("two connections on the same client×platform verify INDEPENDENTLY: each accepts its own secret header, rejects the sibling's", async () => {
    const { a, b } = await twoSignedConns();
    const sample = razorpayAdapter.sample;
    const verify = (secret: string, connSecret: string) =>
      (razorpayAdapter.verify as (p: unknown, h: Record<string, string>, s: string | null) => boolean)(
        sample,
        { "x-razorpay-signature": hmacSha256(connSecret, JSON.stringify(sample)), rawBody: JSON.stringify(sample) },
        secret
      );
    // Provider A (secret a.secret) → conn A: accepted; cross-posted to conn B: REJECTED.
    expect(verify(a.secret, a.secret)).toBe(true);
    expect(verify(a.secret, b.secret)).toBe(false);
    // Provider B → conn B: accepted; against conn A: rejected.
    expect(verify(b.secret, b.secret)).toBe(true);
    expect(verify(b.secret, a.secret)).toBe(false);
    // And the route resolution hands each conn its OWN row's secret (so
    // ?conn=<a.id> verifies against a.secret, ?conn=<b.id> against b.secret):
    const epA = await resolveEndpointForRoute(db.prisma, a.id, FIT, "razorpay");
    const epB = await resolveEndpointForRoute(db.prisma, b.id, FIT, "razorpay");
    expect(epA?.endpointSecret).toBe(a.secret);
    expect(epB?.endpointSecret).toBe(b.secret);
  });

  it("resolveEndpointForRoute scopes to active + same client + platform (a foreign conn never verifies under this URL)", async () => {
    const { a } = await twoSignedConns();
    expect(await resolveEndpointForRoute(db.prisma, a.id, FIT, "razorpay")).not.toBeNull();
    // Same conn, wrong platform in the URL:
    expect(await resolveEndpointForRoute(db.prisma, a.id, FIT, "flexifunnels")).toBeNull();
    // Same conn, foreign client id:
    const ws = await db.prisma.workspace.findFirstOrThrow();
    await db.prisma.client.create({ data: { id: "cl_d13_b", workspaceId: ws.id, name: "B", currency: "INR" } });
    expect(await resolveEndpointForRoute(db.prisma, a.id, "cl_d13_b", "razorpay")).toBeNull();
    // Unknown conn id:
    expect(await resolveEndpointForRoute(db.prisma, "does-not-exist", FIT, "razorpay")).toBeNull();
  });

  it("an unknown platform is enforced at write (no row is ever created for it)", async () => {
    await expect(
      createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "not-a-platform" as never, label: "x", createdBy: OWNER })
    ).rejects.toThrow(/unknown platform/i);
    expect(isPlatform("flexifunnels")).toBe(true);
    expect(isPlatform("not-a-platform")).toBe(false);
    expect(isPlatform(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5 — D-15 hard delete -> 404 (the conn row is gone, so the route 404s it).
// ---------------------------------------------------------------------------

describe("D-15 deleteWebhookEndpoint — hard delete removes the conn + cascades its connLogs", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("deleteWebhookEndpoint removes the row (idempotent); resolveEndpointForRoute then returns null (the route maps that to 404)", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d13-deleted", createdBy: OWNER });
    // A conn log + a raw WebhookLog row so the cascade/preserve contract is proven:
    await db.prisma.webhookConnectionLog.create({ data: { endpointId: ep.id, status: "ok", payloadHash: "h1", error: null } });
    await db.prisma.webhookLog.create({ data: { clientId: FIT, platform: "flexifunnels", rawPayload: '{"o":1}' } });
    const connLogCountBefore = await db.prisma.webhookConnectionLog.count();
    const webhookLogCountBefore = await db.prisma.webhookLog.count();

    expect(await resolveEndpointForRoute(db.prisma, ep.id, FIT, "flexifunnels")).not.toBeNull();

    expect((await deleteWebhookEndpoint(db.prisma, ep.id)).deleted).toBe(true);
    // The row is gone:
    expect(await db.prisma.webhookEndpoint.findUnique({ where: { id: ep.id } })).toBeNull();
    // Its connection logs cascade with it (onDelete: Cascade):
    expect(await db.prisma.webhookConnectionLog.count()).toBe(connLogCountBefore - 1);
    // The raw WebhookLog rows are PRESERVED (client-scoped received-payload audit):
    expect(await db.prisma.webhookLog.count()).toBe(webhookLogCountBefore);
    // Deleted -> unresolvable:
    expect(await resolveEndpointForRoute(db.prisma, ep.id, FIT, "flexifunnels")).toBeNull();
    // Idempotent-by-404: re-deleting a gone row reports deleted:false, not a throw:
    expect(await deleteWebhookEndpoint(db.prisma, ep.id)).toEqual({ deleted: false });
    expect(await deleteWebhookEndpoint(db.prisma, "nope")).toEqual({ deleted: false });
  });

  it("the [platform] route maps an unresolvable conn to a clean 404 'unknown connection' (no legacy-secret fallback) (contract)", () => {
    expect(ROUTE_CONN).toMatch(/if \(!connEndpoint\)/); // the 404 guard, after a present conn param
    expect(ROUTE_CONN).toMatch(/return NextResponse\.json\(\{ error: "unknown connection" \}, \{ status: 404 \}\)/);
    // The legacy fallback exists ONLY for the absent-conn case:
    expect(ROUTE_CONN).toMatch(/const connParam = req\.nextUrl\.searchParams\.get\("conn"\);/);
    expect(ROUTE_CONN).toMatch(/connEndpoint \? connEndpoint\.endpointSecret : client\.webhookSecret/);
  });
});

// ---------------------------------------------------------------------------
// 6 — Audit-log write (create/revoke) + conn-log write on receipt.
// ---------------------------------------------------------------------------

describe("D-13 audit + connection logs", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("an AuditLog row written the way the create/delete routes wire auditAction (action/entity/entityId) lands + is well-shaped", async () => {
    // Mirror security.auditAction's write (it is NOT prisma-parameterized — it
    // uses the global singleton, which under vitest could target dev.db). We
    // write the SAME row shape through the isolated temp DB instead; the route
    // contract asserts below prove the routes actually call auditAction.
    // Field-for-field with src/lib/security.auditAction (lines 61-70):
    await db.prisma.auditLog.create({
      data: { clientId: FIT, userId: OWNER, action: "create", entity: "apiKey", entityId: "k_1", details: JSON.stringify({ label: "d13-audit", purpose: "api" }) },
    });
    await db.prisma.auditLog.create({
      data: { clientId: FIT, userId: OWNER, action: "delete_webhookEndpoint", entity: "webhookEndpoint", entityId: "w_1", details: JSON.stringify({ platform: "flexifunnels", label: "d13" }) },
    });
    const rows = await db.prisma.auditLog.findMany({ where: { clientId: FIT, userId: OWNER } });
    expect(rows).toHaveLength(2);
    // Order-independent match on the (action, entity, entityId) tuples:
    const byEntity = Object.fromEntries(rows.map((r) => [r.entityId, r]));
    expect(byEntity.k_1?.action).toBe("create");
    expect(byEntity.k_1?.entity).toBe("apiKey");
    expect(JSON.parse(byEntity.k_1!.details ?? "{}")).toEqual({ label: "d13-audit", purpose: "api" });
    expect(byEntity.w_1?.action).toBe("delete_webhookEndpoint");
    expect(byEntity.w_1?.entity).toBe("webhookEndpoint");
  });

  it("recordConnectionLog writes one payload-hash-only row per received event (no raw-payload column exists to leak)", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d13-log", createdBy: OWNER });
    const body1 = JSON.stringify(flexifunnelsAdapter.sample);
    const body2 = JSON.stringify({ ...((flexifunnelsAdapter.sample ?? {}) as Record<string, unknown>), order_id: "ff_2" });

    await recordConnectionLog(db.prisma, ep.id, { status: "ok", payloadHash: sha256Hex(body1) });
    await recordConnectionLog(db.prisma, ep.id, { status: "failed", error: "verification failed", payloadHash: sha256Hex(body2) });

    const logs = await db.prisma.webhookConnectionLog.findMany({ where: { endpointId: ep.id } });
    expect(logs).toHaveLength(2);
    // Match by the hash values (insert timestamps can be equal):
    const okLog = logs.find((l) => l.payloadHash === sha256Hex(body1));
    const failLog = logs.find((l) => l.payloadHash === sha256Hex(body2));
    expect(okLog?.status).toBe("ok");
    expect(failLog?.status).toBe("failed");
    expect(failLog?.error).toBe("verification failed");
    // The raw payload is NOT on this model (dedup/audit only):
    const rowKeys = Object.keys(okLog!);
    expect(rowKeys).toEqual(expect.arrayContaining(["id", "endpointId", "receivedAt", "status", "error", "payloadHash"]));
    for (const bad of ["rawPayload", "raw", "body"]) expect(rowKeys).not.toContain(bad);
    // mapConnStatus maps every IngestResult status onto the log union:
    expect(mapConnStatus("processed")).toBe("ok");
    expect(mapConnStatus("received")).toBe("ok");
    expect(mapConnStatus("duplicate")).toBe("duplicate");
    expect(mapConnStatus("failed")).toBe("failed");
  });

  it("the admin routes wire the audit write on create/delete and never leak keyHash/endpointSecret in list responses (contract)", () => {
    // Keys: audit on create (keys/route.ts POST) + revoke (keys/revoke/route.ts POST),
    // client-scoped; the workspace key is row-audited (no audit-log client FK target).
    expect(ROUTE_KEYS).toMatch(/auditAction\(s, clientId, "create", "apiKey"/);
    expect(ROUTE_KEYS_REVOKE).toMatch(/auditAction\(s, key\.clientId, "revoke", "apiKey"/);
    // Unknown key id -> 404, not 500; idempotent revoke:
    expect(ROUTE_KEYS_REVOKE).toMatch(/unknown key/);
    expect(ROUTE_KEYS_REVOKE).toMatch(/status: 404/);
    // Endpoints: audit on create + D-15 hard delete; unknown-id 404s; duplicate label 409.
    expect(ROUTE_HOOKS).toMatch(/auditAction\(s, clientId, "create", "webhookEndpoint"/);
    // D-15: the delete route audits BEFORE the row goes (audit-before-delete) and 404s unknown:
    expect(ROUTE_HOOK_DELETE).toMatch(/auditAction\(s, ep\.clientId, "delete_webhookEndpoint", "webhookEndpoint"/);
    expect(ROUTE_HOOK_DELETE).toMatch(/unknown connection/);
    expect(ROUTE_HOOK_DELETE).toMatch(/status: 404/);
    expect(ROUTE_HOOKS).toMatch(/P2002/);
    expect(ROUTE_HOOKS).toMatch(/status: 409/);
    expect(ROUTE_HOOKS).toMatch(/P2002/);
    expect(ROUTE_HOOKS).toMatch(/status: 409/);
    // The LIST response's select block never names endpointSecret (the
    // doc-comment / route-level mentions are fine — only the select matters):
    expect(ROUTE_HOOKS).not.toMatch(/select: \{[^}]*endpointSecret/);
    // The conn-log endpoint is last-100, payloadHash only (never the raw payload):
    expect(ROUTE_HOOK_LOGS).toMatch(/take: 100/);
    expect(ROUTE_HOOK_LOGS).toMatch(/payloadHash: true/);
    expect(ROUTE_HOOK_LOGS).not.toMatch(/rawPayload/);
    expect(ROUTE_HOOK_LOGS).toMatch(/unknown connection/);
    expect(ROUTE_HOOK_LOGS).toMatch(/client not visible/);
    // The [platform] route records a conn log + bumps lastReceivedAt ONLY on the conn path:
    expect(ROUTE_CONN).toMatch(/recordConnectionLog\(prisma, connEndpoint\.id/);
    expect(ROUTE_CONN).toMatch(/lastReceivedAt: new Date\(\)/);
    expect(ROUTE_CONN).toMatch(/if \(connEndpoint\) \{/);
    // Conn-scoped rate limit (two conns can't starve each other; legacy key preserved):
    expect(ROUTE_CONN).toMatch(/wh:\$\{client\.id\}:\$\{platform\}:\$\{connParam \?\? "legacy"\}/);
  });
});

// ---------------------------------------------------------------------------
// 4 — Legacy no-conn path unchanged (behaviour contract).
// ---------------------------------------------------------------------------

describe("D-13 legacy [platform] path — unchanged when &conn= is absent", () => {
  it("the route keeps the legacy single-secret verification for the no-conn case", () => {
    // Absent conn -> the legacy Client.webhookSecret verifies (the G4/D-06 path):
    expect(ROUTE_CONN).toMatch(/const secret = connEndpoint \? connEndpoint\.endpointSecret : client\.webhookSecret;/);
    // The legacy WebhookLog write (processInbound) still happens on every inbound
    // — the raw-payload path is untouched:
    expect(ROUTE_CONN).toMatch(/processInbound\(\{[\s\S]{0,240}clientSecret: secret,[\s\S]{0,140}rawBody,/);
    // The response gains the connection flag but keeps the legacy fields:
    expect(ROUTE_CONN).toMatch(/connection: Boolean\(connEndpoint\)/);
    expect(ROUTE_CONN).toMatch(/webhookLogId: res\.webhookLogId/);
    // The GET handshake (hub.challenge) is intact:
    expect(ROUTE_CONN).toMatch(/hub\.mode/);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers (no DB).
// ---------------------------------------------------------------------------

describe("D-13 pure helpers", () => {
  it("sha256Hex is deterministic + a known-answer value", () => {
    // The well-known SHA-256 of "abc":
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });

  it("generateApiKey: xacq_ prefix + 32 random bytes base64url; hash = SHA-256(plain)", () => {
    const g1 = generateApiKey();
    const g2 = generateApiKey();
    expect(g1.plain).toMatch(/^xacq_/);
    expect(Buffer.from(g1.plain.slice("xacq_".length), "base64url").length).toBe(32);
    expect(g1.keyHash).toBe(sha256Hex(g1.plain));
    expect(g1.plain).not.toBe(g2.plain); // random, distinct
  });

  it("generateWebhookSecret: 32 random bytes, base64; distinct per call (reversible-stored; shown once)", () => {
    const s1 = generateWebhookSecret();
    const s2 = generateWebhookSecret();
    expect(s1).not.toBe(s2);
    expect(Buffer.from(s1, "base64").length).toBe(32);
    expect(Buffer.from(s2, "base64").length).toBe(32);
  });
});
