import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { freshDb, TestDb } from "./helpers";
import { PrismaClient } from "@prisma/client";
import {
  clientIpFromHeaders,
  maskIp,
  ingestTrackerEvent,
  createTrackingProject,
  workspaceProjectIds,
  trackerDashboard,
  trackerProjectSummaries,
  setProjectStatus,
} from "../src/lib/tracker";
import { pickPublicBase, noteLiveHost, baseFromHostHeader } from "../src/lib/live-host";

/**
 * D-17 / Device Track — the visitor + lead tracking data layer
 * (src/lib/tracker.ts) and the self-capturing live host (src/lib/live-host.ts).
 * The ingest is idempotent by design: unknown/inactive project → no rows; a
 * replayed (visitor, session, eventType, timestamp) → no-op; a pageview + a
 * lead in the same instant → BOTH rows (the dedup key includes the event
 * kind). The dashboard's lead KPIs + conversion rate mirror the merged MVP
 * (totalLeads / uniqueVisitors, 0 when no visitors — never a fake ratio).
 */
let db: TestDb;
const prisma = (): PrismaClient => db.prisma;

beforeEach(async () => {
  db = await freshDb(); // tenancy: workspace + two users + cl_upcurvv + G1 account
});
afterAll(async () => {
  await db?.close();
});

async function ctx() {
  const p = prisma();
  const ws = await p.workspace.findFirst();
  const user = await p.user.findFirst();
  const cl = await p.client.findFirst();
  if (!ws || !user || !cl) throw new Error("tenancy bootstrap missing");
  return { p, ws: ws.id, user: user.id, cl: cl.id };
}

// ---------------------------------------------------------------------------
// Pure helpers (no DB)
// ---------------------------------------------------------------------------

describe("clientIpFromHeaders — the SERVER-captured IP priority", () => {
  it("prefers cf-connecting-ip, then x-real-ip, then the first x-forwarded-for hop", () => {
    expect(clientIpFromHeaders({ "cf-connecting-ip": "1.2.3.4" })).toBe("1.2.3.4");
    expect(clientIpFromHeaders({ "x-real-ip": "5.6.7.8", "cf-connecting-ip": "" })).toBe("5.6.7.8");
    expect(
      clientIpFromHeaders({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })
    ).toBe("9.9.9.9"); // first hop = the real client
    expect(clientIpFromHeaders({})).toBeNull();
  });
});

describe("maskIp — role-aware IP display (spec §10)", () => {
  it("owner/admin see the full IP; everyone else the last-octet mask", () => {
    expect(maskIp("1.2.3.4", { role: "owner" as const })).toBe("1.2.3.4");
    expect(maskIp("1.2.3.4", { role: "admin" as const })).toBe("1.2.3.4");
    expect(maskIp("1.2.3.4", { role: "viewer" as const })).toBe("1.2.3.xxx");
    expect(maskIp("2001:db8::7", { role: "viewer" as const })).toBe("…:7"); // v6 tail
    expect(maskIp(null, { role: "viewer" as const })).toBe("—");
  });
});

// ---------------------------------------------------------------------------
// Ingest (Phase 3): upsert + dedup + the lead-capture kind
// ---------------------------------------------------------------------------

describe("ingestTrackerEvent — unknown / inactive / replay / lead", () => {
  it("an unknown project writes NOTHING (the route 404s)", async () => {
    const { p } = await ctx();
    const r = await ingestTrackerEvent(
      p,
      { projectId: "nope", visitorId: "v_1", timestamp: new Date().toISOString() },
      "1.2.3.4"
    );
    expect(r).toEqual({ ok: false, reason: "unknown_project" });
    expect(await p.visitorEvent.count()).toBe(0);
  });

  it("an inactive project writes NOTHING (the route 204s)", async () => {
    const { p, ws, user } = await ctx();
    const proj = await createTrackingProject(p, {
      workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", createdBy: user,
    });
    await setProjectStatus(p, proj.id, "inactive");
    const r = await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_1" }, "1.2.3.4");
    expect(r).toEqual({ ok: false, reason: "inactive" });
    expect(await p.visitorEvent.count()).toBe(0);
    await db.close();
  });

  it("a normal pageview upserts the visitor + session + event; a REPLAY is a no-op", async () => {
    const { p, ws, user } = await ctx();
    const proj = await createTrackingProject(p, {
      workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp",
      clientId: undefined, createdBy: user,
    });
    const ts = "2026-03-01T09:00:00.000Z";
    const base = { projectId: proj.id, visitorId: "v_a", sessionToken: "s_a", timestamp: ts, deviceType: "mobile", browserName: "Chrome" };

    const first = await ingestTrackerEvent(p, base, "1.2.3.4");
    expect(first.ok).toBe(true);

    // The replay (same visitor + session + kind + instant): a no-op.
    const replay = await ingestTrackerEvent(p, base, "1.2.3.4");
    expect(replay).toEqual({ ok: true, id: first.ok ? first.id : "", duplicate: true });

    const ev = await p.visitorEvent.count({ where: { projectId: proj.id } });
    expect(ev).toBe(1); // the replay wrote NOTHING
    const visitor = await p.trackedVisitor.findFirst({ where: { visitorId: "v_a" } });
    expect(visitor?.totalVisits).toBe(1);
    expect(await p.visitorSession.count({ where: { sessionToken: "s_a" } })).toBe(1);
    await db.close();
  });

  it("a pageview + a lead in the same instant BOTH land (the dedup key includes the kind)", async () => {
    const { p, ws, user } = await ctx();
    const proj = await createTrackingProject(p, {
      workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", createdBy: user,
    });
    const ts = "2026-03-01T09:00:00.000Z";
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_a", sessionToken: "s_a", timestamp: ts, eventType: "pageview" }, "1.2.3.4");
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_a", sessionToken: "s_a", timestamp: ts, eventType: "lead", leadSource: "submit" }, "1.2.3.4");
    // A replay of the LEAD (same kind): a no-op.
    const again = await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_a", sessionToken: "s_a", timestamp: ts, eventType: "lead", leadSource: "submit" }, "1.2.3.4");
    expect(again.ok).toBe(true);
    if (again.ok) expect(again.duplicate).toBe(true); // narrow the union

    const rows = await p.visitorEvent.findMany({ where: { projectId: proj.id }, orderBy: { eventType: "asc" } });
    expect(rows).toHaveLength(2); // pageview + lead, NOT a third replayed lead
    const lead = rows.find((r) => r.eventType === "lead")!;
    expect(lead.leadSource).toBe("submit");
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// The client-narrowing + the lead KPIs (Phase 4 / Device Track)
// ---------------------------------------------------------------------------

describe("workspaceProjectIds — the client-narrowing axis", () => {
  it("narrows to one client's projects (an unassigned project is all-clients only)", async () => {
    const { p, ws, user, cl } = await ctx();
    await createTrackingProject(p, { workspaceId: ws, name: "A", landingPageName: "lp", landingPageUrl: "https://x.example/a", clientId: cl, createdBy: user });
    await createTrackingProject(p, { workspaceId: ws, name: "B", landingPageName: "lp", landingPageUrl: "https://x.example/b", clientId: null, createdBy: user });

    expect(await workspaceProjectIds(p, ws)).toHaveLength(2); // all
    expect(await workspaceProjectIds(p, ws, cl)).toHaveLength(1); // client A only
    await db.close();
  });
});

describe("trackerProjectSummaries — the per-project list (incl. the raw MAX(timestamp) BigInt)", () => {
  it("returns the owning client + event count + last event; the raw SQL MAX(timestamp) comes back as a BigInt of unix-ms and must not crash `new Date`", async () => {
    const { p, ws, user, cl } = await ctx();
    const proj = await createTrackingProject(p, { workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", clientId: cl, createdBy: user });
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_1", sessionToken: "s_1", timestamp: "2026-03-01T09:00:00.000Z" }, "1.2.3.4");

    const rows = await trackerProjectSummaries(p, ws);
    const mine = rows.find((r) => r.id === proj.id);
    expect(mine).toBeDefined();
    expect(mine!.clientId).toBe(cl);
    expect(mine!.clientName).toBe(
      (await p.client.findUnique({ where: { id: cl } }))?.name
    );
    expect(mine!.eventCount).toBe(1);
    // The regression: MAX(timestamp) is a raw-SQL int64 (a BigInt of ms);
    // `new Date(bigint)` throws "Cannot convert a BigInt value to a number".
    // The normaliser must hand back a real Date at the ingested instant.
    expect(mine!.lastEventAt).toBeInstanceOf(Date);
    expect((mine!.lastEventAt as Date).getTime()).toBe(Date.parse("2026-03-01T09:00:00.000Z"));
    await db.close();
  });

  it("a project with NO events has lastEventAt null (not a crash)", async () => {
    const { p, ws, user } = await ctx();
    const proj = await createTrackingProject(p, { workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", createdBy: user });
    const rows = await trackerProjectSummaries(p, ws);
    const mine = rows.find((r) => r.id === proj.id);
    expect(mine!.eventCount).toBe(0);
    expect(mine!.lastEventAt).toBeNull();
    await db.close();
  });
});

describe("trackerDashboard — the lead KPIs + conversion rate", () => {
  it("counts leads off eventType='lead', computes conversionRate, lists recentLeads; totalPageViews counts pageviews only", async () => {
    const { p, ws, user, cl } = await ctx();
    const proj = await createTrackingProject(p, { workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", clientId: cl, createdBy: user });
    const ts = new Date().toISOString();
    // Two visitors: one converts (pageview + lead), one only visits (pageview).
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_1", sessionToken: "s_1", timestamp: ts, eventType: "pageview" }, "1.1.1.1");
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_1", sessionToken: "s_1", timestamp: ts, eventType: "lead", leadSource: "thankyou" }, "1.1.1.1");
    await ingestTrackerEvent(p, { projectId: proj.id, visitorId: "v_2", sessionToken: "s_2", timestamp: ts, eventType: "pageview" }, "2.2.2.2");

    const dash = await trackerDashboard(p, [proj.id]);
    expect(dash.totalPageViews).toBe(2); // the two pageviews (NOT the lead)
    expect(dash.uniqueVisitors).toBe(2);
    expect(dash.totalLeads).toBe(1);
    expect(dash.conversionRate).toBe(50); // 1 lead / 2 unique visitors
    expect(dash.recentLeads).toHaveLength(1);
    expect(dash.recentLeads[0].leadSource).toBe("thankyou");
    expect(dash.recentLeads[0].visitorId).toBe("v_1");
    await db.close();
  });

  it("conversionRate is 0 (never a fake / divide-by-zero) with no visitors", async () => {
    const { p, ws, user } = await ctx();
    const proj = await createTrackingProject(p, { workspaceId: ws, name: "P", landingPageName: "lp", landingPageUrl: "https://x.example/lp", createdBy: user });
    const dash = await trackerDashboard(p, [proj.id]);
    expect(dash.conversionRate).toBe(0);
    expect(dash.uniqueVisitors).toBe(0);
    await db.close();
  });
});

// ---------------------------------------------------------------------------
// The self-capturing live host (D-17): source-of-truth + the capture guards
// ---------------------------------------------------------------------------

describe("pickPublicBase — the host precedence (the pure resolver)", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  it("a FRESH liveHost wins over every .env tier", () => {
    const seen = new Date(now.getTime() - 60_000);
    const r = pickPublicBase({
      liveHost: "https://fresh.trycloudflare.com", liveHostSeenAt: seen, now,
      env: { PUBLIC_BASE_URL: "https://stale.example", NEXT_PUBLIC_BASE_URL: "https://n.example" },
    });
    expect(r).toMatchObject({ base: "https://fresh.trycloudflare.com", source: "workspace.liveHost", liveHostFresh: true });
  });

  it("a STALE liveHost (> TTL) falls back to the .env tiers, then localhost", () => {
    const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000); // > 24 h
    const r = pickPublicBase({
      liveHost: "https://fresh.trycloudflare.com", liveHostSeenAt: stale, now,
      env: { PUBLIC_BASE_URL: "https://stale.example" },
    });
    expect(r.source).toBe("PUBLIC_BASE_URL");
    expect(r.base).toBe("https://stale.example");
    expect(r.liveHostFresh).toBe(false);

    const none = pickPublicBase({ liveHost: null, liveHostSeenAt: null, now, env: {} });
    expect(none).toMatchObject({ base: "http://localhost:3000", source: "localhost-dev" });
  });
});

describe("noteLiveHost — the capture guards (idempotent, localhost-safe, no clobber)", () => {
  it("a quick-tunnel Host self-captures; a second identical request is a no-op", async () => {
    const { p, ws } = await ctx();
    const req = (host: string) => ({ headers: { get: (k: string) => (k === "host" ? host : null) } });
    // `prisma: p` → the TEMP test DB (noteLiveHost defaults to the live
    // dev.db PrismaClient when omitted — that's what we must NOT hit here).
    const r1 = await noteLiveHost(req("new-tunnel.trycloudflare.com"), { workspaceId: ws, prisma: p });
    expect(r1.captured).toBe(true);
    expect(await p.workspace.findUnique({ where: { id: ws } })).toMatchObject({ liveHost: "https://new-tunnel.trycloudflare.com" });

    // The same host again: UNCHANGED (no write storm).
    const r2 = await noteLiveHost(req("new-tunnel.trycloudflare.com"), { workspaceId: ws, prisma: p });
    expect(r2.captured).toBe(false);
    expect(r2.reason).toBe("unchanged");
    await db.close();
  });

  it("a localhost Host NEVER writes (the dev-time majority must not clobber)", async () => {
    const { p, ws } = await ctx();
    const r = await noteLiveHost(
      { headers: { get: (k) => (k === "host" ? "localhost:3000" : null) } },
      { workspaceId: ws, prisma: p }
    );
    expect(r.captured).toBe(false);
    expect(r.reason).toBe("not-capturable");
    expect((await p.workspace.findUnique({ where: { id: ws } }))?.liveHost).toBeNull();
    await db.close();
  });
});
