/**
 * Single-writer pull lock (Dashboard-V2 §3: "one pull process at a time; a
 * running tick must skip, never parallelize").
 *
 * The hazard this guards is the one the idempotency pass hit: two `tsx`
 * writers (a 10-min tick + a manual pull + the durable cron) hammering the same
 * SQLite file at once. A file lock survives across processes (an in-memory flag
 * does not), so any path that pulls Meta → writes the DB acquires it first.
 *
 * Semantics:
 *   - lock free, or STALE (> TTL, a holder that died without releasing) ->
 *     acquire (write {pid, at});
 *   - lock held FRESH by another pid -> skip (acquired: false); the caller
 *     logs + moves on, never parallelizes.
 * The lock path + holder pid are injectable so the unit test drives it hermetically.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LOCK = join(here, "..", "..", ".xacqora-pull.lock");

/** A holder that hasn't been seen this long is assumed dead -> steal it. A
 *  full rollup over a few-thousand ads can take many minutes, so this is
 *  generous on purpose: we'd rather skip than double-write. */
export const LOCK_TTL_MS = 30 * 60_000;

export interface PullLockHandle {
  acquired: boolean;
  /** human reason: "acquired" | "held by pid … since …" */
  reason: string;
}

export interface LockOpts {
  lockPath?: string;
  /** override the recorded holder pid (tests); defaults to process.pid */
  pid?: number;
}

export function defaultLockPath(): string {
  return DEFAULT_LOCK;
}

/**
 * Try to take the pull lock. `acquired:false` means "someone else is pulling
 * right now — skip this tick." A corrupt lock file is treated as absent
 * (best-effort: we'd rather steal a broken lock than be wedged forever).
 */
export function acquirePullLock(opts?: LockOpts): PullLockHandle {
  const lockPath = opts?.lockPath ?? DEFAULT_LOCK;
  const pid = opts?.pid ?? process.pid;
  let holder: { pid: number; at: number } | null = null;
  try {
    if (existsSync(lockPath)) holder = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    holder = null;
  }
  const now = Date.now();
  if (holder && typeof holder.at === "number" && now - holder.at < LOCK_TTL_MS) {
    return { acquired: false, reason: `held by pid ${holder.pid} since ${new Date(holder.at).toISOString()}` };
  }
  writeFileSync(lockPath, JSON.stringify({ pid, at: now }));
  return { acquired: true, reason: "acquired" };
}

/**
 * Release the lock we took. Removes the file only when we still own it
 * (pid match) — so a slow holder whose lock was stolen after the TTL doesn't
 * nuke the new holder's lock. A lock that's already gone is a no-op.
 */
export function releasePullLock(opts?: LockOpts): void {
  const lockPath = opts?.lockPath ?? DEFAULT_LOCK;
  const pid = opts?.pid ?? process.pid;
  try {
    const holder = JSON.parse(readFileSync(lockPath, "utf8"));
    if (holder?.pid === pid) unlinkSync(lockPath);
  } catch {
    /* already released / stolen — nothing to do */
  }
}

/** Force-clear the lock (test/ops escape hatch). */
export function clearPullLock(opts?: { lockPath?: string }): void {
  const lockPath = opts?.lockPath ?? DEFAULT_LOCK;
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  }
}
