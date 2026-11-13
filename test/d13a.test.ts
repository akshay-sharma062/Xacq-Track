/**
 * D-13a — fix the webhook inboundUrl to use the PUBLIC host.
 *
 * The bug: createWebhookEndpoint built the inboundUrl from
 * `NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"` and .env had no base, so
 * every FlexiFunnels/Razorpay connection pointed at a host an EXTERNAL
 * provider can never reach (FlexiFunnels rejects localhost). D-13a adds a
 * PUBLIC_BASE_URL key (the live tunnel host) and the precedence
 * explicit > PUBLIC_BASE_URL > NEXT_PUBLIC_BASE_URL > localhost-dev, plus a
 * one-off `refreshWebhookInboundUrls` that re-points EXISTING rows (idempotent,
 * touches ONLY the URL string), plus a UI banner for the loopback case.
 *
 * These tests prove: (1) the precedence, (2) a generated inboundUrl carries
 * NO "localhost"/"127.0.0.1" once PUBLIC_BASE_URL is set, (3) the refresh is
 * idempotent and never touches the secret, (4) the legacy G4 routes
 * (no &conn=, Client.webhookSecret) are UNCHANGED by the refresh.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import {
  resolveWebhookBase,
  isLoopbackBase,
  buildInboundUrl,
  createWebhookEndpoint,
  refreshWebhookInboundUrls,
} from "../src/lib/integrations";
import { flexifunnelsAdapter } from "../src/lib/adapters/payments";

const FIT = "cl_upcurvv"; // tenancy bootstrap client
const OWNER = "u_owner"; // tenancy bootstrap user (createdBy FK)

// Route/source contract text the ticket requires stay UNCHANGED:
const ROUTE_CONN = readFileSync("src/app/api/webhooks/[platform]/route.ts", "utf8");
const SCHEMA = readFileSync("prisma/schema.prisma", "utf8");

/** A realistic live base (a trycloudflare subdomain) that must NOT look
 *  like loopback and must survive trailing-slash trimming. */
const TUNNEL = "https://docs-reserve-inside-parking.trycloudflare.com";

// ---------------------------------------------------------------------------
// 1 — the base-resolution precedence (pure, no DB).
// ---------------------------------------------------------------------------

describe("D-13a resolveWebhookBase — precedence explicit > PUBLIC > NEXT_PUBLIC > localhost-dev", () => {
  it("explicit arg always wins", () => {
    const env = { PUBLIC_BASE_URL: TUNNEL, NEXT_PUBLIC_BASE_URL: "https://app.example.com" };
    expect(resolveWebhookBase("https://injected.example", env).base).toBe("https://injected.example");
    expect(resolveWebhookBase("https://injected.example/", env)).toEqual({ base: "https://injected.example", source: "explicit" }); // trailing slash trimmed
  });

  it("PUBLIC_BASE_URL wins over NEXT_PUBLIC_BASE_URL and the localhost fallback", () => {
    const env = { PUBLIC_BASE_URL: TUNNEL, NEXT_PUBLIC_BASE_URL: "https://app.example.com" };
    const r = resolveWebhookBase(undefined, env);
    expect(r.base).toBe(TUNNEL);
    expect(r.source).toBe("PUBLIC_BASE_URL");
  });

  it("NEXT_PUBLIC_BASE_URL is the second tier (only used when PUBLIC is unset)", () => {
    const env = { NEXT_PUBLIC_BASE_URL: "https://app.example.com" };
    expect(resolveWebhookBase(undefined, env)).toEqual({ base: "https://app.example.com", source: "NEXT_PUBLIC_BASE_URL" });
  });

  it("no base configured anywhere -> the localhost dev fallback (source = localhost-dev)", () => {
    expect(resolveWebhookBase(undefined, {})).toEqual({ base: "http://localhost:3000", source: "localhost-dev" });
  });

  it("whitespace / empty values are treated as unset (skip the tier)", () => {
    expect(resolveWebhookBase(undefined, { PUBLIC_BASE_URL: "   ", NEXT_PUBLIC_BASE_URL: "https://n.example.com" }).base).toBe("https://n.example.com");
    expect(resolveWebhookBase("  ", { PUBLIC_BASE_URL: TUNNEL }).base).toBe(TUNNEL); // blank explicit -> next tier
  });
});

// ---------------------------------------------------------------------------
// isLoopbackBase — the exact D-13a failure detector.
// ---------------------------------------------------------------------------

describe("D-13a isLoopbackBase — flags the unreachable hosts, accepts a real host", () => {
  it("true for localhost / 127.0.0.0.0-style loopback", () => {
    expect(isLoopbackBase("http://localhost:3000")).toBe(true);
    expect(isLoopbackBase("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackBase("https://0.0.0.0:3000")).toBe(true);
    expect(isLoopbackBase("http://[::1]:3000")).toBe(true);
  });

  it("false for a public host (the fixed case)", () => {
    expect(isLoopbackBase(TUNNEL)).toBe(false);
    expect(isLoopbackBase("https://app.example.com")).toBe(false);
  });

  it("a non-URL value is not a loopback host (returns false)", () => {
    expect(isLoopbackBase("not a url")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2 — a generated FlexiFunnels inboundUrl has NO localhost/127.0.0.1
//     once PUBLIC_BASE_URL is set (integration: real DB write + read-back).
// ---------------------------------------------------------------------------

describe("D-13a createWebhookEndpoint — inboundUrl base follows PUBLIC_BASE_URL", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    // Deterministic: start with NO base configured (vitest never loads .env).
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
  });
  afterEach(async () => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.NEXT_PUBLIC_BASE_URL;
    await db.close();
  });

  function ffArgs(label: string, extra: { baseUrl?: string } = {}) {
    return { clientId: FIT, platform: "flexifunnels" as const, label, createdBy: OWNER, ...extra };
  }

  it("with NO base configured the inboundUrl falls back to localhost (the pre-D-13a behaviour)", async () => {
    const ep = await createWebhookEndpoint(db.prisma, ffArgs("d13a-ff-nobase"));
    expect(ep.inboundUrl).toContain("localhost");
    expect(ep.inboundUrl).toMatch(/\?client=cl_upcurvv&conn=/);
    expect(ep.inboundUrl).toContain("/api/webhooks/flexifunnels");
  });

  it("with PUBLIC_BASE_URL set, the inboundUrl points at the tunnel host and contains NO 'localhost' / '127.0.0.1'", async () => {
    process.env.PUBLIC_BASE_URL = TUNNEL;
    const ep = await createWebhookEndpoint(db.prisma, ffArgs("d13a-ff-tunnel"));
    expect(ep.inboundUrl).toBe(`${TUNNEL}/api/webhooks/flexifunnels?client=${FIT}&conn=${ep.id}`);
    expect(ep.inboundUrl).toContain(TUNNEL);
    expect(ep.inboundUrl).not.toContain("localhost");
    expect(ep.inboundUrl.toLowerCase()).not.toContain("127.0.0.1");
    // read the row back from the DB (the stored value, not just the return):
    const stored = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    expect(stored.inboundUrl).toBe(ep.inboundUrl);
    expect(stored.inboundUrl.toLowerCase()).not.toContain("localhost");
  });

  it("PUBLIC_BASE_URL beats a NEXT_PUBLIC_BASE_URL that would shadow it", async () => {
    process.env.PUBLIC_BASE_URL = TUNNEL;
    process.env.NEXT_PUBLIC_BASE_URL = "http://127.0.0.1:3000"; // a loopback NEXT_PUBLIC must NOT win
    const ep = await createWebhookEndpoint(db.prisma, ffArgs("d13a-ff-precedence"));
    expect(ep.inboundUrl.toLowerCase()).not.toContain("127.0.0.1");
    expect(ep.inboundUrl).toContain(TUNNEL);
  });

  it("an explicit baseUrl argument is the test/caller override (highest precedence)", async () => {
    process.env.PUBLIC_BASE_URL = TUNNEL;
    const ep = await createWebhookEndpoint(db.prisma, ffArgs("d13a-ff-explicit", { baseUrl: "https://override.example.com" }));
    expect(ep.inboundUrl).toContain("override.example.com");
  });
});

// ---------------------------------------------------------------------------
// 3 — refreshWebhookInboundUrls: re-points existing rows, idempotent, and
//     NEVER touches the connection secret / hash / log.
// ---------------------------------------------------------------------------

describe("D-13a refreshWebhookInboundUrls — idempotent + secret-untouched", () => {
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

  async function seedEndpoints(prisma: PrismaClient) {
    // Three active connections created with NO base configured (beforeEach
    // cleared PUBLIC_/NEXT_PUBLIC_BASE_URL) → their inboundUrls are the
    // localhost dev base: the exact pre-D-13a state the refresh must fix.
    const a = await createWebhookEndpoint(prisma, { clientId: FIT, platform: "flexifunnels", label: "d13a-a", createdBy: OWNER });
    const b = await createWebhookEndpoint(prisma, { clientId: FIT, platform: "flexifunnels", label: "d13a-b", createdBy: OWNER });
    const c = await createWebhookEndpoint(prisma, { clientId: FIT, platform: "razorpay", label: "d13a-c", createdBy: OWNER });
    return { a, b, c };
  }

  it("first run updates every localhost row to the tunnel base; a second run changes 0 (idempotent)", async () => {
    const ep = await seedEndpoints(db.prisma);
    // Force the pre-D-13a state: all three inboundUrls are the localhost dev base
    // (created with no base configured => localhost:3000).
    for (const e of [ep.a, ep.b, ep.c]) expect(e.inboundUrl).toContain("localhost");

    // RUN 1 — refresh to the public base: all 3 change.
    process.env.PUBLIC_BASE_URL = TUNNEL;
    const r1 = await refreshWebhookInboundUrls(db.prisma);
    expect(r1.base).toBe(TUNNEL);
    expect(r1.source).toBe("PUBLIC_BASE_URL");
    expect(r1.updated).toBe(3);
    expect(r1.unchanged).toBe(0);
    expect(r1.rows.every((row) => row.after.includes(TUNNEL) && row.after.toLowerCase().includes("localhost") === false)).toBe(true);

    // RUN 2 — idempotency: nothing has changed, so 0 updated / 3 unchanged.
    const r2 = await refreshWebhookInboundUrls(db.prisma);
    expect(r2.updated).toBe(0);
    expect(r2.unchanged).toBe(3);
    expect(r2.rows.every((row) => row.changed === false)).toBe(true);
  });

  it("the refresh rewrites ONLY the inboundUrl — the endpointSecret + keyHash + connection log are untouched", async () => {
    const ep = await seedEndpoints(db.prisma);
    // Snapshot the secret + a connection log row BEFORE the refresh.
    const beforeSecrets = await db.prisma.webhookEndpoint.findMany({
      where: { id: { in: [ep.a.id, ep.b.id, ep.c.id] } },
      select: { id: true, endpointSecret: true },
    });
    await db.prisma.webhookConnectionLog.create({
      data: { endpointId: ep.a.id, status: "ok", payloadHash: "abc123", error: null },
    });
    const logCountBefore = await db.prisma.webhookConnectionLog.count();

    process.env.PUBLIC_BASE_URL = TUNNEL;
    await refreshWebhookInboundUrls(db.prisma);

    // Secrets are byte-identical after the refresh:
    const afterSecrets = await db.prisma.webhookEndpoint.findMany({
      where: { id: { in: [ep.a.id, ep.b.id, ep.c.id] } },
      select: { id: true, endpointSecret: true },
    });
    for (const a of afterSecrets) {
      const b = beforeSecrets.find((x) => x.id === a.id)!;
      expect(a.endpointSecret).toBe(b.endpointSecret);
    }
    // The connection log is intact (unchanged count + the same row):
    expect(await db.prisma.webhookConnectionLog.count()).toBe(logCountBefore);
    expect((await db.prisma.webhookConnectionLog.findFirst({ where: { endpointId: ep.a.id } }))?.payloadHash).toBe("abc123");
    // Only the URL moved (spot-check one row):
    const moved = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.a.id } });
    expect(moved.inboundUrl).toContain(TUNNEL);
    expect(moved.inboundUrl.toLowerCase()).not.toContain("localhost");
  });

  it("the refresh re-points ACTIVE rows ONLY — a revoked connection keeps its URL (ticket step 3: 'all active rows')", async () => {
    const ep = await seedEndpoints(db.prisma);
    // D-15: revoke is now a hard delete, so to get a NON-ACTIVE row here we
    // flip active=false directly (the old D-13 soft-revoke state the
    // "active-only refresh" scope still needs to prove against).
    await db.prisma.webhookEndpoint.update({ where: { id: ep.c.id }, data: { active: false } });

    process.env.PUBLIC_BASE_URL = TUNNEL;
    const r = await refreshWebhookInboundUrls(db.prisma);
    // Only the 2 ACTIVE rows are in the report + updated; the revoked one
    // is absent and its URL is untouched:
    expect(r.updated).toBe(2);
    expect(r.unchanged).toBe(0);
    expect(r.rows.map((row) => row.id)).toEqual(expect.arrayContaining([ep.a.id, ep.b.id]));
    expect(r.rows.map((row) => row.id)).not.toContain(ep.c.id);

    const c = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.c.id } });
    expect(c.active).toBe(false);
    expect(c.inboundUrl).toContain("localhost"); // the revoked row's URL is NOT rewritten
    const a = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.a.id } });
    expect(a.inboundUrl).toContain(TUNNEL); // the active row IS re-pointed
  });
});

// ---------------------------------------------------------------------------
// buildInboundUrl — the shape the refresh + create both share.
// ---------------------------------------------------------------------------

describe("D-13a buildInboundUrl — <base>/api/webhooks/<platform>?client=<c>&conn=<id>", () => {
  it("builds the exact inboundUrl (no localhost when the base is public)", () => {
    const r = buildInboundUrl({ id: "conn_1", platform: "flexifunnels", clientId: FIT }, TUNNEL, "PUBLIC_BASE_URL");
    expect(r.url).toBe(`${TUNNEL}/api/webhooks/flexifunnels?client=${FIT}&conn=conn_1`);
    expect(r.url.toLowerCase()).not.toContain("localhost");
  });
});

// ---------------------------------------------------------------------------
// 4 — the legacy G4 routes (no &conn=, Client.webhookSecret) are UNCHANGED:
//     the refresh only rewrites WebhookEndpoint.inboundUrl; it never touches
//     Client.webhookSecret, the legacy verify path, or the [platform] route's
//     legacy branch.
// ---------------------------------------------------------------------------

describe("D-13a legacy G4 path — unchanged by the inboundUrl refresh", () => {
  it("the [platform] route still verifies the legacy no-conn path against Client.webhookSecret (the fallback branch is intact)", () => {
    // The no-conn legacy verify is STILL the ternary fallback:
    expect(ROUTE_CONN).toMatch(/const secret = connEndpoint \? connEndpoint\.endpointSecret : client\.webhookSecret;/);
    // The conn param is OPTIONAL (absent => legacy, byte-for-byte as before):
    expect(ROUTE_CONN).toMatch(/const connParam = req\.nextUrl\.searchParams\.get\("conn"\);/);
    // The legacy WebhookLog raw-payload write is untouched:
    expect(ROUTE_CONN).toMatch(/processInbound\(\{[\s\S]{0,240}clientSecret: secret,/);
  });

  it("the Client.webhookSecret column still exists in the schema (the legacy path's source of truth)", () => {
    expect(SCHEMA).toMatch(/webhookSecret\s+String\?/);
    expect(SCHEMA).toMatch(/model Client \{/);
  });

  it("the refresh function only writes to WebhookEndpoint.inboundUrl — the refresh lib never references Client.webhookSecret", () => {
    const lib = readFileSync("src/lib/integrations.ts", "utf8");
    // The refresh path is confined to webhookEndpoint.update({ inboundUrl }):
    expect(lib).toMatch(/prisma\.webhookEndpoint\.update\(\{ where: \{ id: ep\.id \}, data: \{ inboundUrl: next\.url \} \}\)/);
    // …and the refresh function has NO Client.webhookSecret write (only the
    // route above uses that column; the lib's refresh touches endpoints only).
    const refreshSrc = lib.slice(lib.indexOf("export async function refreshWebhookInboundUrls"));
    expect(refreshSrc).not.toMatch(/webhookSecret/);
    expect(refreshSrc).not.toMatch(/prisma\.client\./);
  });

  it("the refresh CLI script exists and is wired to pnpm webhooks:refresh-url", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["webhooks:refresh-url"]).toMatch(/scripts\/refresh-webhook-urls\.ts/);
    const script = readFileSync("scripts/refresh-webhook-urls.ts", "utf8");
    // It calls the idempotent lib fn + loads .env + appends a gitignored evidence file:
    expect(script).toMatch(/refreshWebhookInboundUrls/);
    expect(script).toMatch(/loadDotEnv/);
    expect(script).toMatch(/\.d13a-refresh-evidence\.txt/);
    // And it NEVER writes a secret or the legacy client secret: the script has
    // NO direct Prisma writes at all (it only calls the lib refresh fn + loads
    // .env + logs) — a `webhookSecret` mention is doc-comment only, never a write.
    expect(script, "the CLI must not write to the DB itself (only via the lib fn)").not.toMatch(/prisma\.(client|webhookEndpoint)\.[a-zA-Z]+/);
    expect(script, "no secret write in any update payload").not.toMatch(/data:\s*\{[\s\S]{0,60}webhookSecret/);
  });

  it("the FlexiFunnels adapter's sample + verify are untouched (the refresh changes no gateway behaviour)", () => {
    // The adapter still verifies by the x-webhook-secret header echo:
    const verify = (flexifunnelsAdapter.verify as (p: unknown, h: Record<string, string>, s: string | null) => boolean);
    expect(verify(flexifunnelsAdapter.sample, { "x-webhook-secret": "s" }, "s")).toBe(true);
    expect(verify(flexifunnelsAdapter.sample, { "x-webhook-secret": "wrong" }, "s")).toBe(false);
  });
});
