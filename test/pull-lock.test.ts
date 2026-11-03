import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquirePullLock, releasePullLock, LOCK_TTL_MS } from "../src/jobs/pull-lock";
import { fastTickDue } from "../src/jobs/pull-scheduler";

/**
 * Dashboard-V2 §3 single-writer discipline (the lesson from the idempotency
 * pass): one pull process at a time. The lock is file-based (survives across
 * processes — an in-memory flag would not) and injectable, so this test drives
 * it hermetically with no live Meta and no shared dev.db.
 */
let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xacqora-lock-"));
  lockPath = join(dir, "lock.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("acquirePullLock — single-writer skip (§3)", () => {
  it("acquires when no lock is present", () => {
    const r = acquirePullLock({ lockPath, pid: 111 });
    expect(r.acquired).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(111);
  });

  it("SKIPS (does not parallelize) when a FRESH lock is held by another pid", () => {
    // Simulate another process that just took the lock.
    writeFileSync(lockPath, JSON.stringify({ pid: 222, at: Date.now() }));
    const r = acquirePullLock({ lockPath, pid: 111 });
    expect(r.acquired).toBe(false);
    expect(r.reason).toContain("held by pid 222");
    // The held lock must survive: we did NOT steal or nuke it.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(222);
  });

  it("steals a STALE lock (holder died >TTL ago) so a wedged process can't block forever", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 222, at: Date.now() - (LOCK_TTL_MS + 5000) }));
    const r = acquirePullLock({ lockPath, pid: 111 });
    expect(r.acquired).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(111);
  });
});

describe("releasePullLock — only the owner releases", () => {
  it("owner's release removes the lock; a later re-acquire succeeds", () => {
    const a = acquirePullLock({ lockPath, pid: 111 });
    expect(a.acquired).toBe(true);
    releasePullLock({ lockPath, pid: 111 });
    expect(existsSync(lockPath)).toBe(false);
  });

  it("a SLOW holder whose lock was stolen does NOT nuke the new holder's lock", () => {
    acquirePullLock({ lockPath, pid: 111 });
    // Simulate the lock being stolen (stale) and re-taken by pid 333.
    writeFileSync(lockPath, JSON.stringify({ pid: 333, at: Date.now() }));
    // Now the old holder (111) finally finishes and tries to release.
    releasePullLock({ lockPath, pid: 111 });
    // pid 333's lock must still be there — 111 isn't its owner.
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(333);
  });
});

describe("fastTickDue — 10-min grid (§3)", () => {
  const GRID = 10 * 60_000;
  it("fires when never fired", () => expect(fastTickDue(null, 0)).toBe(true));

  it("does not re-fire inside the same 10-min slot", () => {
    const last = GRID; // fired exactly at a slot boundary
    expect(fastTickDue(last, last + 5 * 60_000)).toBe(false); // 5 min later
  });

  it("fires once the next 10-min boundary is reached", () => {
    const last = GRID;
    expect(fastTickDue(last, last + 10 * 60_000)).toBe(true); // full grid later
  });
});
