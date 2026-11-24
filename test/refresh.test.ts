/**
 * D-22 — pull-on-refresh + data preloader.
 *
 * The route's REAL behaviour is tested at the proven boundary (fresh temp DB +
 * the DEMO_USER session + the global prisma reset, the d14 pattern), with ONLY
 * `pullAllAccounts` mocked — so the Meta network layer is faked, but the whole
 * route decision logic (role gate, owner-client target, throttle, the 90 s cap,
 * lock acquire/release) runs for real against a real SQLite file.
 *
 * The ticket's required cases:
 *   1. Slow-pull cap: a pull that outlasts REFRESH_PULL_MAX_MS returns
 *      `pulled:false + runningInBackground` (NEVER a fake success) while the
 *      pull keeps running in the background; on the NEXT refresh the data is
 *      there (`lastPulledAt` stamped, lock released).
 *   2. Role-gating: 401 unauthenticated + 403 for a non-pull role.
 *   3. Throttle bypass: two auto pulls inside the 5-min min gap → the 2nd
 *      skips Meta (`pulled:false`, "throttled"); force:true bypasses it.
 *   4. Preloader source contract: the client-side 90 s cap + AbortController +
 *      the honest background/abort notes are wired in DataPreloader.tsx +
 *      PipelinePullButton.tsx (asserted on source, the D-12/D-13 precedent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import { clearPullLock } from "../src/jobs/pull-lock";

// ---------------------------------------------------------------------------
// The ONLY fake: pullAllAccounts. Everything else in the route is real.
// ---------------------------------------------------------------------------
const pull = vi.hoisted(() => ({
  impl: null as null | ((...args: unknown[]) => Promise<unknown>),
  calls: [] as unknown[][],
}));

vi.mock("@/lib/meta/pull", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/meta/pull")>("@/lib/meta/pull");
  return {
    ...actual,
    pullAllAccounts: (...args: unknown[]) => {
      pull.calls.push(args);
      if (!pull.impl) throw new Error("pull.impl not set in this test");
      return pull.impl(...args);
    },
  };
});

const G1 = "act_4749960348632164"; // the bootstrap ad account (client cl_upcurvv)
const OWNER = "arpit@foremostleads.in"; // the bootstrap owner

function makeReq(body: Record<string, unknown>) {
  // The route only reads req.json() — a minimal stand-in is enough.
  return { json: async () => body } as any;
}

let db: TestDb;

beforeEach(async () => {
  db = await freshDb(); // tenancy bootstrap: ws_agency + cl_upcurvv + G1 link row
  process.env.DEMO_USER = OWNER;
  process.env.META_ACCESS_TOKEN = "test-token";
  delete process.env.META_SIMULATE;
  delete process.env.REFRESH_PULL_MIN_MS;
  delete process.env.REFRESH_PULL_MAX_MS;
  clearPullLock(); // the documented test/ops escape hatch — never wedged
  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).globalPrisma = undefined; // re-imports key to THIS temp DB
  pull.impl = null;
  pull.calls.length = 0;
});

afterEach(async () => {
  delete process.env.DEMO_USER;
  delete process.env.META_ACCESS_TOKEN;
  delete process.env.REFRESH_PULL_MIN_MS;
  delete process.env.REFRESH_PULL_MAX_MS;
  await db.close();
});

// ---------------------------------------------------------------------------
// 1 — slow-pull cap: the route never fakes a success past the cap, and the
//     pull keeps going in the background so the NEXT refresh sees the data.
// ---------------------------------------------------------------------------
describe("D-22 slow-pull cap (REFRESH_PULL_MAX_MS)", () => {
  it("a pull outlasting the cap returns pulled:false + runningInBackground (never a fake success); the data lands on the next refresh", async () => {
    process.env.REFRESH_PULL_MAX_MS = "150"; // cap the response at 150 ms
    // The Meta pull hangs 500 ms, THEN stamps lastPulledAt (the data landing).
    pull.impl = async (...args: unknown[]) => {
      const clientId = args[1] as string;
      const metaIds = args[3] as string[];
      await new Promise((r) => setTimeout(r, 500));
      for (const m of metaIds) {
        await db.prisma.adAccount.update({ where: { metaId: m }, data: { lastPulledAt: new Date() } });
      }
      return { results: [], failures: [] };
    };

    const route = await import("../src/app/api/meta/refresh/route");
    const j1: any = await (await route.POST(makeReq({ adAccount: G1, client: "cl_upcurvv" }))).json();

    // The cap fired before the pull settled: honest no-success, not fake.
    expect(j1.pulled).toBe(false);
    expect(j1.runningInBackground).toBe(true);
    expect(j1.reason).toMatch(/cap|background/i);
    // The pull actually ran in the background (the mock's 500 ms body fired):
    expect(pull.calls.length).toBe(1);
    await new Promise((r) => setTimeout(r, 600)); // let the bg pull settle + stamp

    // NEXT refresh: the data is there. force:true (bypasses the throttle) now
    // also proves the lock was released when the bg pull settled — a stuck
    // lock would answer "another pull is running" instead of pulled:true.
    pull.impl = async () => ({ results: [], failures: [] });
    const j2: any = await (await route.POST(makeReq({ adAccount: G1, client: "cl_upcurvv", force: true }))).json();
    expect(j2.pulled).toBe(true);
    expect(j2.dataAsOf).toBeTruthy(); // the stamped lastPulledAt is visible
  });
});

// ---------------------------------------------------------------------------
// 2 — role-gating: 401 unauthenticated / 403 non-pull role.
// ---------------------------------------------------------------------------
describe("D-22 role-gating", () => {
  it("unauthenticated (a session that resolves to no user) → 401", async () => {
    // `.env` ships DEMO_USER (vitest loads it), so `delete` is unreliable —
    // point it at a NONEXISTENT email instead: currentUser() returns null →
    // the route's 401 branch, deterministically.
    process.env.DEMO_USER = "nobody@nowhere.invalid";
    pull.impl = async () => ({ results: [], failures: [] });
    const route = await import("../src/app/api/meta/refresh/route");
    const res = await route.POST(makeReq({ adAccount: G1 }));
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error).toMatch(/unauthenticated/i);
    expect(pull.calls.length).toBe(0); // no Meta call ever fires
  });

  it("a viewer role (no pull_meta) → 403", async () => {
    await db.prisma.user.create({
      data: {
        id: "u_viewer",
        workspaceId: "ws_agency",
        email: "viewer@foremostleads.in",
        name: "V Viewer",
        role: "viewer",
        clientAccess: "[]",
      },
    });
    process.env.DEMO_USER = "viewer@foremostleads.in";
    pull.impl = async () => ({ results: [], failures: [] });
    const route = await import("../src/app/api/meta/refresh/route");
    const res = await route.POST(makeReq({ adAccount: G1 }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/forbidden/i);
    expect(pull.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — throttle: an auto pull inside the 5-min min gap skips Meta; force
//     bypasses it (the manual "Pull now" path).
// ---------------------------------------------------------------------------
describe("D-22 throttle + force bypass", () => {
  it("two auto pulls inside the min gap: the 2nd skips Meta (throttled), force:true still pulls", async () => {
    pull.impl = async () => ({ results: [], failures: [] });
    const route = await import("../src/app/api/meta/refresh/route");
    const body = { adAccount: G1, client: "cl_upcurvv" };

    const j1: any = await (await route.POST(makeReq(body))).json();
    expect(j1.pulled).toBe(true); // first auto pull in → real pull ran

    const j2: any = await (await route.POST(makeReq(body))).json();
    expect(j2.pulled).toBe(false); // inside the 5-min min gap → Meta skipped
    expect(j2.reason).toMatch(/throttl/i);
    expect(pull.calls.length).toBe(1); // the 2nd never reached Meta

    const j3: any = await (await route.POST(makeReq({ ...body, force: true }))).json();
    expect(j3.pulled).toBe(true); // force bypasses the throttle
    expect(pull.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 4 — preloader source contract (the client-side 90 s cap + honest notes).
// ---------------------------------------------------------------------------
describe("D-22 preloader source contract", () => {
  const PRELOADER = readFileSync("src/app/components/DataPreloader.tsx", "utf8");
  const PIPELINE_BTN = readFileSync("src/app/components/PipelinePullButton.tsx", "utf8");
  const ROUTE_SRC = readFileSync("src/app/api/meta/refresh/route.ts", "utf8");

  it("the preloader enforces a client-side 90 s cap + aborts the request (never holds the page hostage)", () => {
    expect(PRELOADER).toMatch(/90_000/); // the cap constant
    expect(PRELOADER).toMatch(/AbortController/);
    expect(PRELOADER).toMatch(/controller\.abort\(\)/);
    expect(PRELOADER).toMatch(/signal:\s*controller\.signal/);
    // The abort note is HONEST: it says the pull continues in the background.
    expect(PRELOADER).toMatch(/background/i);
  });

  it("the pipeline 'Pull now' button posts force:true to /api/meta/refresh", () => {
    expect(PIPELINE_BTN).toMatch(/\/api\/meta\/refresh/);
    expect(PIPELINE_BTN).toMatch(/force:\s*true/);
    expect(PIPELINE_BTN).toMatch(/90_000/); // same client cap
  });

  it("the route caps a single refresh pull at REFRESH_PULL_MAX_MS (default 90 s) and keeps it running in the background", () => {
    expect(ROUTE_SRC).toMatch(/REFRESH_PULL_MAX_MS/);
    expect(ROUTE_SRC).toMatch(/90_000/);
    expect(ROUTE_SRC).toMatch(/runningInBackground/);
    expect(ROUTE_SRC).toMatch(/acquirePullLock/); // the single-writer gate
    expect(ROUTE_SRC).toMatch(/releasePullLock/);
  });
});
