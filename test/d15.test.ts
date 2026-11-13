/**
 * D-15 — host-staleness self-healing + webhook-connection hard delete.
 *
 * Extends the D-13/D-13a webhook-connection work. The repo's webhook
 * inboundUrls are built against a quick-tunnel subdomain (PUBLIC_BASE_URL),
 * which ROTATES on every cloudflared restart — so a stored
 * WebhookEndpoint.inboundUrl can point at a DEAD subdomain while the path
 * (?client=&conn=), the per-connection secret, and the platform are all
 * still valid. D-15 makes that self-heal:
 *
 *   1. urlHost / rehostInboundUrl — pure host-extraction + host-only rewrite
 *      (path + query preserved byte-for-byte; idempotent).
 *   2. currentWebhookHost — the "current live host" known source: the
 *      PO-persisted Workspace.liveHost (set by the Refresh action) wins over
 *      the .env PUBLIC_BASE_URL precedence.
 *   3. refreshWebhookUrlsToHost — re-points every ACTIVE row's inboundUrl to
 *      a host (the host substring only; idempotent; secret untouched).
 *   4. deleteWebhookEndpoint — HARD delete (the PO request "revoke karne
 *      par delete hi ho jaye"): the row + its cascaded WebhookConnectionLog
 *      rows go; the raw WebhookLog rows are PRESERVED (client-scoped
 *      received-payload audit; a heavier purge is a separate PO decision).
 *      Unknown id → { deleted:false } (the route maps that to a clean 404).
 *
 * These tests prove: the host-only rewrite + idempotency, the liveHost
 * precedence, the refresh secret-invariance, and the hard-delete
 * cascade/preserve/404 semantics.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import {
  urlHost,
  rehostInboundUrl,
  currentWebhookHost,
  refreshWebhookUrlsToHost,
  deleteWebhookEndpoint,
  createWebhookEndpoint,
} from "../src/lib/integrations";

const FIT = "cl_upcurvv"; // tenancy bootstrap client
const OWNER = "u_owner"; // tenancy bootstrap user (createdBy FK)

// Route-file contract text the D-15 guarantees pin:
const ROUTE_HOOKS = readFileSync("src/app/api/admin/webhooks/route.ts", "utf8");
const ROUTE_DELETE = readFileSync("src/app/api/admin/webhooks/delete/route.ts", "utf8");
const ROUTE_REFRESH = readFileSync("src/app/api/admin/webhooks/refresh/route.ts", "utf8");

const OLD = "https://dead-subdomain.example.com";
const NEW = "https://fresh-subdomain.example.com";
const FF_PATH = `/api/webhooks/flexifunnels?client=${FIT}&conn=conn_1`;

// ---------------------------------------------------------------------------
// 1 — urlHost / rehostInboundUrl: the host-only rewrite (pure, no DB).
// ---------------------------------------------------------------------------

describe("D-15 urlHost / rehostInboundUrl — rewrite ONLY the host, keep path + query", () => {
  it("urlHost extracts the origin host (with port); null on an unparseable value", () => {
    expect(urlHost(OLD)).toBe("dead-subdomain.example.com");
    expect(urlHost("http://localhost:3000")).toBe("localhost:3000");
    expect(urlHost("not a url")).toBeNull();
    expect(urlHost("")).toBeNull();
  });

  it("rehostInboundUrl swaps ONLY the host — the path (?client=&conn=) survives verbatim", () => {
    const stored = `${OLD}${FF_PATH}`;
    const next = rehostInboundUrl(stored, NEW);
    expect(next).toBe(`${NEW}${FF_PATH}`);
    // The full path + query is byte-identical to the stored one:
    expect(next!.endsWith(FF_PATH)).toBe(true);
    expect(next!.toLowerCase()).not.toContain("dead-subdomain");
  });

  it("rehostInboundUrl is IDEMPOTENT — re-applying the same host returns the equal string", () => {
    const once = rehostInboundUrl(`${OLD}${FF_PATH}`, NEW)!;
    const twice = rehostInboundUrl(once, NEW)!;
    expect(twice).toBe(once);
  });

  it("rehostInboundUrl trims a trailing slash on the new base (canonical host)", () => {
    expect(rehostInboundUrl(`${OLD}${FF_PATH}`, `${NEW}/`)).toBe(`${NEW}${FF_PATH}`);
  });

  it("rehostInboundUrl returns null when either side isn't a parseable URL (no silent mangle)", () => {
    expect(rehostInboundUrl("not a url", NEW)).toBeNull();
    expect(rehostInboundUrl(OLD, "not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2 — currentWebhookHost: the "current live host" KNOWN SOURCE (DB).
// ---------------------------------------------------------------------------

describe("D-15 currentWebhookHost — Workspace.liveHost wins, else the .env base", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });
  afterEach(async () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    await db.close();
  });

  it("with no persisted liveHost it falls back to the .env PUBLIC_BASE_URL tier", async () => {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    process.env.PUBLIC_BASE_URL = NEW;
    const r = await currentWebhookHost(db.prisma, ws.id);
    expect(r.base).toBe(NEW);
    expect(r.source).toBe("PUBLIC_BASE_URL");
  });

  it("the PO-persisted Workspace.liveHost WINS over the .env base (a newer rotation)", async () => {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    process.env.PUBLIC_BASE_URL = OLD; // the .env is stale…
    await db.prisma.workspace.update({ where: { id: ws.id }, data: { liveHost: NEW } }); // …but the DB knows better
    const r = await currentWebhookHost(db.prisma, ws.id);
    expect(r.base).toBe(NEW);
    expect(r.source).toBe("workspace.liveHost");
  });

  it("a null/whitespace liveHost is treated as unset (falls through to the env tiers)", async () => {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    await db.prisma.workspace.update({ where: { id: ws.id }, data: { liveHost: "   " } });
    process.env.PUBLIC_BASE_URL = OLD;
    const r = await currentWebhookHost(db.prisma, ws.id);
    expect(r.base).toBe(OLD);
    expect(r.source).toBe("PUBLIC_BASE_URL");
  });

  it("a trailing slash on the persisted liveHost is trimmed (canonical base)", async () => {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    await db.prisma.workspace.update({ where: { id: ws.id }, data: { liveHost: `${NEW}/` } });
    const r = await currentWebhookHost(db.prisma, ws.id);
    expect(r.base).toBe(NEW);
    expect(r.source).toBe("workspace.liveHost");
  });
});

// ---------------------------------------------------------------------------
// 3 — refreshWebhookUrlsToHost: re-points ACTIVE rows ONLY, idempotent, and
//      NEVER touches the connection secret.
// ---------------------------------------------------------------------------

describe("D-15 refreshWebhookUrlsToHost — host-only rewrite, idempotent + secret-untouched", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });
  afterEach(async () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    await db.close();
  });

  async function seed(prisma: PrismaClient) {
    // Two ACTIVE rows on the OLD (dead) host + one NON-ACTIVE row (the
    // active-only scope must skip it) + a connection-log row on one.
    const a = await createWebhookEndpoint(prisma, { clientId: FIT, platform: "flexifunnels", label: "d15-a", createdBy: OWNER, baseUrl: OLD });
    const b = await createWebhookEndpoint(prisma, { clientId: FIT, platform: "razorpay", label: "d15-b", createdBy: OWNER, baseUrl: OLD });
    await prisma.webhookEndpoint.update({ where: { id: b.id }, data: { active: false } });
    await prisma.webhookConnectionLog.create({ data: { endpointId: a.id, status: "ok", payloadHash: "deadbeef", error: null } });
    return { a, b };
  }

  it("first run re-points the ACTIVE row to the new host; a second run changes 0 (idempotent)", async () => {
    const ep = await seed(db.prisma);
    expect(ep.a.inboundUrl).toContain(OLD);

    const r1 = await refreshWebhookUrlsToHost(db.prisma, NEW);
    expect(r1.updated).toBe(1); // only the active row (b is non-active)
    expect(r1.unchanged).toBe(0);
    expect(r1.rows.find((x) => x.id === ep.a.id)!.after).toBe(`${NEW}${FF_PATH.replace("conn_1", ep.a.id)}`);
    // The stored path+query survived the host swap:
    expect(r1.rows.find((x) => x.id === ep.a.id)!.after).toContain(`?client=${FIT}&conn=${ep.a.id}`);

    const r2 = await refreshWebhookUrlsToHost(db.prisma, NEW);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(1);
    expect(r2.rows.every((x) => x.changed === false)).toBe(true);
  });

  it("the refresh rewrites ONLY the inboundUrl — the endpointSecret + connection log are untouched", async () => {
    const ep = await seed(db.prisma);
    const secretBefore = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.a.id } });
    const logCount = await db.prisma.webhookConnectionLog.count();

    await refreshWebhookUrlsToHost(db.prisma, NEW);

    const after = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.a.id } });
    expect(after.endpointSecret).toBe(secretBefore.endpointSecret); // byte-identical secret
    expect(after.inboundUrl).toContain(NEW);
    // The connection log survived the refresh:
    expect(await db.prisma.webhookConnectionLog.count()).toBe(logCount);
    expect((await db.prisma.webhookConnectionLog.findFirst({ where: { endpointId: ep.a.id } }))?.payloadHash).toBe("deadbeef");
  });

  it("the refresh re-points ACTIVE rows ONLY — a non-active row's URL stays on the dead host", async () => {
    const ep = await seed(db.prisma);
    await refreshWebhookUrlsToHost(db.prisma, NEW);
    // b is non-active: absent from the changed set, its URL is unchanged.
    expect(ep.b.inboundUrl).toContain(OLD);
    const bAfter = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.b.id } });
    expect(bAfter.inboundUrl).toContain(OLD);
  });
});

// ---------------------------------------------------------------------------
// 4 — deleteWebhookEndpoint: HARD delete (cascade connLogs, keep WebhookLog,
//      unknown id → deleted:false).
// ---------------------------------------------------------------------------

describe("D-15 deleteWebhookEndpoint — hard delete: cascade connLogs, keep raw WebhookLog, unknown → 404", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("deletes the row + its cascaded connLogs; PRESERVES the raw WebhookLog rows", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d15-del", createdBy: OWNER });
    // Seed a connLog (cascades) + a raw WebhookLog row (must survive).
    await db.prisma.webhookConnectionLog.create({ data: { endpointId: ep.id, status: "ok", payloadHash: "h1", error: null } });
    await db.prisma.webhookConnectionLog.create({ data: { endpointId: ep.id, status: "failed", error: "verify", payloadHash: "h2" } });
    const connLogsBefore = await db.prisma.webhookConnectionLog.count();
    await db.prisma.webhookLog.create({ data: { clientId: FIT, platform: "flexifunnels", rawPayload: '{"o":1}' } });
    const webhookLogsBefore = await db.prisma.webhookLog.count();

    expect((await deleteWebhookEndpoint(db.prisma, ep.id)).deleted).toBe(true);

    // The endpoint row is gone:
    expect(await db.prisma.webhookEndpoint.findUnique({ where: { id: ep.id } })).toBeNull();
    // Its connection logs cascaded with it (onDelete: Cascade):
    expect(await db.prisma.webhookConnectionLog.count()).toBe(connLogsBefore - 2);
    // The RAW WebhookLog rows are PRESERVED (the received-payload audit):
    expect(await db.prisma.webhookLog.count()).toBe(webhookLogsBefore);
  });

  it("is idempotent-by-404: a gone / unknown id reports deleted:false (the route maps that to 404, never a 500)", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d15-idem", createdBy: OWNER });
    expect(await deleteWebhookEndpoint(db.prisma, ep.id)).toEqual({ deleted: true });
    // The row is gone: re-deleting it is a clean no-op, not a throw:
    expect(await deleteWebhookEndpoint(db.prisma, ep.id)).toEqual({ deleted: false });
    expect(await deleteWebhookEndpoint(db.prisma, "nope")).toEqual({ deleted: false });
  });

  it("the DELETE route audits BEFORE the delete + 404s an unknown id (contract)", () => {
    // The audit row is written ahead of the hard delete so it outlives it:
    expect(ROUTE_DELETE).toMatch(/auditAction\(s, ep\.clientId, "delete_webhookEndpoint", "webhookEndpoint", ep\.id/);
    expect(ROUTE_DELETE).toMatch(/const res = await deleteWebhookEndpoint\(prisma, id\);/);
    // …and the audit-before ordering is textual: auditAction appears before the delete call.
    const auditIdx = ROUTE_DELETE.indexOf('auditAction(s, ep.clientId, "delete_webhookEndpoint"');
    const delIdx = ROUTE_DELETE.indexOf("deleteWebhookEndpoint(prisma, id)");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(delIdx).toBeGreaterThan(auditIdx);
    // Unknown (or already-deleted) id → clean 404, never a 500:
    expect(ROUTE_DELETE).toMatch(/unknown connection/);
    expect(ROUTE_DELETE).toMatch(/status: 404/);
    // The audit details carry platform + label only — NEVER the endpointSecret:
    expect(ROUTE_DELETE).not.toMatch(/endpointSecret/);
  });

  it("the admin webhooks GET surface exposes the D-15 stale host fields (contract)", () => {
    // Each row carries its stored host + a stale flag vs. the current host;
    // the response also names the known-source current host.
    expect(ROUTE_HOOKS).toMatch(/currentBaseSource/);
    expect(ROUTE_HOOKS).toMatch(/stale/);
    expect(ROUTE_HOOKS).toMatch(/currentBase/);
  });

  it("the REFRESH route persists Workspace.liveHost + audits each changed row (contract)", () => {
    // The host is persisted as the known source the list's stale-badge uses:
    expect(ROUTE_REFRESH).toMatch(/prisma\.workspace\.update\(\{ where: \{ id: s\.workspaceId \}, data: \{ liveHost: host \} \}\)/);
    // One audit row per CHANGED row (an idempotent run writes none):
    expect(ROUTE_REFRESH).toMatch(/for \(const row of res\.rows\.filter\(\(r\) => r\.changed\)\)/);
    expect(ROUTE_REFRESH).toMatch(/refresh_webhookEndpoint/);
    // A non-URL host is rejected up front (no silent no-op):
    expect(ROUTE_REFRESH).toMatch(/must be an absolute base URL/);
  });
});
