import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { freshDb } from "./helpers";
import type { TestDb } from "./helpers";
import { onboardAccounts, slugifyOwner, normalizeAccountStatus } from "../src/lib/meta/pull";

describe("slugifyOwner (D-04 client naming)", () => {
  it("slugifies an account name for cl_<slug>", () => {
    expect(slugifyOwner("The Job Workshop Ad account")).toBe("the-job-workshop-ad-account");
    expect(slugifyOwner("FML New")).toBe("fml-new");
  });
  it("caps length + strips leading/trailing dashes", () => {
    const long = "a-".repeat(50);
    expect(slugifyOwner(long).length).toBeLessThanOrEqual(40);
    expect(slugifyOwner("  -- -- ")).toBe("");
  });
});

describe("normalizeAccountStatus (Meta numeric status -> String column)", () => {
  it("maps the known numeric codes", () => {
    expect(normalizeAccountStatus(1)).toBe("ACTIVE");
    expect(normalizeAccountStatus(0)).toBe("DISABLED");
  });
  it("passes through unknown codes + string forms without guessing", () => {
    expect(normalizeAccountStatus("ACTIVE")).toBe("ACTIVE");
    expect(normalizeAccountStatus("1")).toBe("ACTIVE");
    expect(normalizeAccountStatus("suspended")).toBe("SUSPENDED");
    expect(normalizeAccountStatus(7)).toBe("7");
  });
  it("defaults null/empty to ACTIVE (the bootstrap default)", () => {
    expect(normalizeAccountStatus(null)).toBe("ACTIVE");
    expect(normalizeAccountStatus(undefined)).toBe("ACTIVE");
  });
});

/**
 * PO ticket 2026-11-02, Step 4: "a per-account failure in one account never
 * aborts the others" — simulated with ONE 403 mid-batch. Account B is a
 * permission-denied account (Meta 403 + a named permission); account A after
 * it must still onboard. No network: `fetch` is stubbed, the G1 pull path is
 * what runs against the stubs.
 */
let db: TestDb;

function meta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterAll(async () => {
  await db?.close();
});

describe("onboardAccounts — per-account 403 isolation", () => {
  beforeEach(async () => {
    db = await freshDb({ seed: false });
  });

  it("a 403 account is recorded BLOCKED (exact error + permission); the next account still onboards", async () => {
    const GOOD = "act_1111";
    const BAD = "act_2222";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes(BAD)) {
          // Meta's real 403 shape: an OAuth payload that names the missing
          // permission in the message (fetchAccountIdentity extracts it).
          return meta(403, {
            error: {
              message: `(#200) User does not have permission ads_read on ad account ${BAD}`,
              type: "OAuthException",
              code: 200,
            },
          });
        }
        if (u.includes(GOOD)) {
          // /ads -> empty ad list (fast, 0 spend rows); the account meta
          // read returns name + currency + account_status (a NUMBER, as the
          // live API returns).
          if (u.includes("/ads")) return meta(200, { data: [] });
          return meta(200, { name: "Good Co", currency: "INR", account_status: 1 });
        }
        return meta(200, { data: [] });
      })
    );

    // BAD first, so a GOOD after it proves the batch did NOT abort.
    const { onboarded, blocked } = await onboardAccounts(
      db.prisma,
      [BAD, GOOD],
      "FAKE_TOKEN",
      "v23.0"
    );
    vi.unstubAllGlobals();

    // The 403 account: BLOCKED, with the exact Meta error + the extracted permission.
    expect(blocked).toHaveLength(1);
    expect(blocked[0].metaId).toBe(BAD);
    expect(blocked[0].status).toBe(403);
    expect(blocked[0].permission).toBe("ads_read");
    expect(blocked[0].error).toMatch(/403/);
    expect(blocked[0].error).toMatch(/ads_read/);
    // A 403 account must NOT have provisioned a client.
    expect(onboarded.find((o) => o.metaId === BAD)).toBeUndefined();

    // The good account onboarded AFTER the 403 (isolation proven).
    expect(onboarded).toHaveLength(1);
    const g = onboarded[0];
    expect(g.metaId).toBe(GOOD);
    expect(g.name).toBe("Good Co");
    expect(g.status).toBe("ACTIVE"); // normalized from Meta's numeric 1
    expect(g.clientId).toMatch(/^cl_/); // auto-provisioned (D-04)
    expect(g.spendRows).toBe(0); // empty ad list

    // Auto-provisioned tenant rows (Step 2, zero-manual):
    const cl = await db.prisma.client.findUnique({ where: { id: g.clientId } });
    expect(cl?.name).toBe("Good Co");
    const link = await db.prisma.adAccount.findUnique({ where: { metaId: GOOD } });
    expect(link?.clientId).toBe(g.clientId);
    expect(link?.displayOwnerName).toBe("Good Co");
    expect(link?.status).toBe("ACTIVE");
  });

  it("idempotent: re-running an already-onboarded account reuses its client + never duplicates spend", async () => {
    const GOOD = "act_3333";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes(GOOD)) {
          if (u.includes("/ads")) {
            // One ad + one insights row, twice-identical, to prove upsert dedup.
            if (u.includes("/insights"))
              return meta(200, {
                data: [
                  { date_stop: "2026-10-30", spend: "10.0", impressions: 100, reach: 50, clicks: 20, results: [] },
                ],
              });
            return meta(200, {
              data: [{ id: "adX", name: "Ad X", status: "ACTIVE", campaign: { id: "c1", name: "C" }, adset: { id: "s1", name: "S" } }],
            });
          }
          return meta(200, { name: "Three Co", currency: "INR", account_status: 1 });
        }
        return meta(200, { data: [] });
      })
    );

    const first = await onboardAccounts(db.prisma, [GOOD], "FAKE_TOKEN", "v23.0");
    const second = await onboardAccounts(db.prisma, [GOOD], "FAKE_TOKEN", "v23.0");
    vi.unstubAllGlobals();

    // Same client both runs (mapping never re-parented / duplicated).
    expect(first.onboarded[0].clientId).toBe(second.onboarded[0].clientId);
    // Exactly one client + one link row + one ad + one spend row, despite 2 pulls.
    expect(await db.prisma.client.count({ where: { name: "Three Co" } })).toBe(1);
    expect(await db.prisma.adAccount.count({ where: { metaId: GOOD } })).toBe(1);
    expect(await db.prisma.ad.count({ where: { metaId: "adX" } })).toBe(1);
    expect(await db.prisma.spend.count({ where: { adMetaId: "adX" } })).toBe(1);
  });
});
