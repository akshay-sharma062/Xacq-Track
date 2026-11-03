/**
 * Meta ads-pull scheduler (spec 5.7: "Every night and every 3 hours during the
 * day"). Dependency-free so it runs on the boring stack:
 *
 *   - `cadenceForHour(h)` — PURE: which pull fires at a given local (IST)
 *     hour. Nightly = a 30-day backfill at 02:00; daytime = a 1-day pull every
 *     3h (07,10,13,16,19,22).
 *   - `runDuePulls()` — one full pass: for each client that has an ad account,
 *     the REAL pull (skipped cleanly when the token is absent — a missing
 *     secret must never crash the scheduler; it logs and moves on).
 *   - `startLoop()` — resident process (`pnpm jobs:pull`): fires each slot at
 *     most once per calendar day. This is the local/dev runner.
 *
 * DURABILITY: upserts make every pull idempotent (re-run = no-op on the same
 * day), and in production the durable trigger is a platform cron
 * (Vercel cron / a host timer) hitting `POST /api/jobs/pull` — the scheduler
 * process is the fallback for a single-node host. Failures alert on
 * console.error (Sentry is wired in G10).
 */
import { prisma } from "../lib/prisma";
import { pullAllAccounts, onboardAccounts, normalizeAdAccountRef } from "../lib/meta/pull";
import { backfillMissingInr, BackfillResult } from "../lib/fx-store";
import { acquirePullLock, releasePullLock } from "./pull-lock";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load `.env` into `process.env` for the CLI entry (`pnpm jobs:pull` /
 * `pull:once`). Next.js auto-loads .env for routes, but a bare `tsx` process
 * does not — and a scheduler that can't see its token would "skip" every
 * night silently. Existing process.env values always win. Values are never
 * logged.
 */
function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, "..", "..", ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// ---------------------------------------------------------------------------
// Pure cadence (unit-tested)
// ---------------------------------------------------------------------------
export type Cadence = "backfill30" | "daily1";

/** Which pull (if any) fires at local hour `h` (0–23, IST in prod). */
export function cadenceForHour(h: number): Cadence | null {
  if (h === 2) return "backfill30"; // nightly backfill (spec: "every night")
  if (h % 3 === 1 && h >= 7 && h <= 22) return "daily1"; // 07,10,13,16,19,22
  return null; // idle: 0,1,3,4,5,6,23
}

// ---------------------------------------------------------------------------
// One pass over every client's ad account
// ---------------------------------------------------------------------------
export interface PullPassResult {
  tokenPresent: boolean;
  simulateMode: boolean;
  ran: { clientId: string; account: string; spendRows: number; errors: string[] }[];
  // clientId is null when the account could not even be read (401/403 on the
  // identity call — no client provisioned yet). permission = the Meta-named
  // missing permission, when Meta gave one (PO: record the exact error).
  failures: {
    clientId: string | null;
    account: string;
    error: string;
    permission?: string | null;
    status?: number | null;
  }[];
  skipped: string[]; // e.g. ["no META_ACCESS_TOKEN"]
}

/**
 * Run one pass. Reads each client's stored AdAccount rows (plus the
 * `META_AD_ACCOUNT_IDS` env list, attributed to the first matching client or
 * the default one when unset) and pulls the REAL Marketing API — unless
 * `META_SIMULATE=1` (then the deterministic fixture keeps reports warm) or
 * the token is absent (then it skips, never throws — a missing secret must
 * not crash the scheduler).
 */
export async function runDuePulls(): Promise<PullPassResult> {
  const out: PullPassResult = {
    tokenPresent: false,
    simulateMode: process.env.META_SIMULATE === "1",
    ran: [],
    failures: [],
    skipped: [],
  };
  const token = process.env.META_ACCESS_TOKEN ?? "";
  out.tokenPresent = Boolean(token);
  const apiVersion = process.env.META_API_VERSION || "v23.0";

  // Every (client, ad account) pair already in the DB (the "known" accounts
  // with a fixed clientId mapping — G1's cl_upcurvv, etc.). Meta refs need the
  // `act_` prefix (operators store bare numbers) — normalise on use.
  const pairs = (await prisma.adAccount.findMany({ select: { clientId: true, metaId: true } })).map((p) => ({
    ...p,
    metaId: normalizeAdAccountRef(p.metaId),
  }));
  if (pairs.length === 0) out.skipped.push("no AdAccount rows configured");

  if (out.simulateMode) {
    out.skipped.push("META_SIMULATE=1 — scheduler runs the deterministic fixture, not the API");
  }
  if (!token && !out.simulateMode) {
    out.skipped.push("no META_ACCESS_TOKEN — real pull skipped (add it to .env)");
  }

  if (token && !out.simulateMode) {
    // (a) DB-known accounts: pull directly through their existing mapping.
    for (const p of pairs) {
      try {
        const { results, failures } = await pullAllAccounts(prisma, p.clientId, token, [p.metaId], apiVersion);
        out.ran.push({
          clientId: p.clientId,
          account: p.metaId,
          spendRows: results.reduce((s, r) => s + r.spendRows, 0),
          errors: failures.map((f) => f.error),
        });
        out.failures.push(
          ...failures.map((f) => ({
            clientId: p.clientId,
            account: p.metaId,
            error: f.error,
            permission: f.permission ?? null,
            status: f.status ?? null,
          }))
        );
      } catch (e: any) {
        // Isolate one account's failure from the rest (spec: "alert on failures").
        out.failures.push({
          clientId: p.clientId,
          account: p.metaId,
          error: String(e?.message ?? e),
          permission: (e as any)?.permission ?? null,
          status: (e as any)?.status ?? null,
        });
        console.error(`[pull-scheduler] ${p.clientId}/${p.metaId}: ${e?.message ?? e}`);
      }
    }

    // (b) D-04 multi-account onboarding: the operator's META_AD_ACCOUNT_IDS is
    //     the "onboard these" list. Any id not already a DB AdAccount row is
    //     read from the API, auto-provisioned (client named after the account)
    //     and full-pulled — zero-manual. A 401/403 on identity read is
    //     isolated as a BLOCKED row (exact Meta error + permission) and the
    //     other accounts continue.
    const dbRefs = new Set(pairs.map((p) => p.metaId));
    const envIds = (process.env.META_AD_ACCOUNT_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeAdAccountRef)
      .filter(Boolean);
    const toOnboard = envIds.filter((r) => !dbRefs.has(r));
    if (toOnboard.length) {
      const { onboarded, blocked } = await onboardAccounts(prisma, toOnboard, token, apiVersion);
      for (const o of onboarded) {
        out.ran.push({
          clientId: o.clientId,
          account: o.metaId,
          spendRows: o.spendRows,
          errors: [],
        });
      }
      for (const b of blocked) {
        out.failures.push({
          clientId: null,
          account: b.metaId,
          error: b.error,
          permission: b.permission,
          status: b.status,
        });
        console.error(
          `[pull-scheduler] BLOCKED ${b.metaId} (Meta ${b.status ?? "?"}, permission ${b.permission ?? "n/a"}): ${b.error}`
        );
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 10-minute fast tick (Dashboard-V2 §3): refresh the day's data + re-try FX,
// single-writer (a running tick is skipped, never parallelized). On this API
// version Meta's no-range rollup is the "daily" granularity (time_range 400s on
// the G1 account — documented G1 limitation), so the fast tick refreshes that
// rollup; it additionally re-runs the multi-source FX fetch + backfill so the
// AED "INR backfill pending" rows clear the moment a source is reachable.
// ---------------------------------------------------------------------------
export interface FastTickResult {
  lock: { acquired: boolean; reason: string };
  skipped: string[];
  pulled: { ran: number; failures: number };
  fx: { updatedRows: number; rates: { currency: string; day: string; rate: number; source: string | null }[] };
}

/**
 * One 10-min tick. Acquires the single-writer pull lock (skip if a pull is
 * already running — the idempotency-lesson discipline), then runs a pull pass
 * over every accessible account + a FX re-fetch/backfill. `lockPath`/`pid` are
 * injectable so the lock test drives it hermetically without live Meta.
 */
export async function runFastTick(
  opts: { lockPath?: string; pid?: number } = {}
): Promise<FastTickResult> {
  const lock = acquirePullLock({ lockPath: opts.lockPath, pid: opts.pid });
  if (!lock.acquired) {
    return {
      lock,
      skipped: [`fast tick skipped — ${lock.reason}`],
      pulled: { ran: 0, failures: 0 },
      fx: { updatedRows: 0, rates: [] },
    };
  }
  try {
    const res = await runDuePulls();
    const fx: BackfillResult = await backfillMissingInr(prisma);
    return {
      lock,
      skipped: res.skipped,
      pulled: { ran: res.ran.length, failures: res.failures.length },
      fx: { updatedRows: fx.updatedRows, rates: fx.rates },
    };
  } finally {
    releasePullLock({ lockPath: opts.lockPath, pid: opts.pid });
  }
}

/** Pure: is a 10-min fast tick due at `nowMs`, given the last-fire time? Fires
 *  on a fixed 10-min grid (deterministic, no drift) — the resident loop uses it. */
export function fastTickDue(lastFiredMs: number | null, nowMs: number): boolean {
  const GRID = 10 * 60_000;
  if (lastFiredMs === null) return true; // never fired → fire now
  // The next grid boundary after `lastFiredMs` is due by `nowMs`.
  const nextSlot = Math.floor(lastFiredMs / GRID) * GRID + GRID;
  return nowMs >= nextSlot;
}

// ---------------------------------------------------------------------------
// Resident loop (local/dev). Fires each cadence slot at most once per day.
// ---------------------------------------------------------------------------
export function startLoop(): { stop: () => void } {
  const firedToday = new Set<string>(); // "YYYY-MM-DD|hour|cadence"
  const tz = process.env.TZ ?? "Asia/Kolkata";
  console.log(`[pull-scheduler] started (TZ=${tz}); night @02:00 (30d) + 07/10/13/16/19/22 (1d)`);

  const tick = async () => {
    const now = new Date();
    // Local hour per the configured TZ (the process TZ, set via env in prod).
    const hour = new Date(now.toLocaleString("en-US", { timeZone: tz })).getHours();
    const cadence = cadenceForHour(hour);
    if (!cadence) return;
    const dayKey = now.toISOString().slice(0, 10);
    const key = `${dayKey}|${hour}|${cadence}`;
    if (firedToday.has(key)) return;
    firedToday.add(key);
    // Meta insights on this account only expose the no-range rollup (30-day
    // window), so both cadence slots pull the same rollup — the cadence label
    // is kept for the log + dedup key only.
    console.log(`[pull-scheduler] firing ${cadence} at local ${String(hour).padStart(2, "0")}:00`);
    try {
      const res = await runDuePulls();
      console.log(`[pull-scheduler] pass done: ${JSON.stringify({ ran: res.ran.length, failures: res.failures.length, skipped: res.skipped })}`);
    } catch (e: any) {
      console.error(`[pull-scheduler] pass failed: ${e?.message ?? e}`);
    }
  };

  const timer = setInterval(() => void tick(), 60_000);
  void tick(); // run immediately at boot

  return {
    stop: () => {
      clearInterval(timer);
      console.log("[pull-scheduler] stopped");
    },
  };
}

// Resident fast-tick loop (Dashboard-V2 §3): fire `runFastTick()` on a fixed
// 10-min grid while the process is up. Shares the same single-writer lock as
// the pull, so a manual `pull:fast` / durable cron and this loop never
// parallelize — one of them skips.
export function startFastLoop(): { stop: () => void } {
  let lastFired: number | null = null;
  console.log("[pull-scheduler] fast tick: every 10 min (fast tick + FX re-fetch), single-writer lock");
  const tick = async () => {
    const now = Date.now();
    if (!fastTickDue(lastFired, now)) return;
    lastFired = now;
    const res = await runFastTick();
    console.log(
      `[pull-scheduler] fast tick ${res.lock.acquired ? "ran" : "skipped"}: pulled ${res.pulled.ran}/${res.pulled.failures} fail, fx backfilled ${res.fx.updatedRows} rows`
    );
  };
  const timer = setInterval(() => void tick(), 60_000);
  void tick();
  return {
    stop: () => {
      clearInterval(timer);
      console.log("[pull-scheduler] fast tick stopped");
    },
  };
}

// CLI entry: `pnpm jobs:pull` → resident loop; `pnpm pull:once` → one pass;
// `pnpm pull:fast` → one 10-min fast tick (pull + FX backfill), lock-guarded.
const isMain = process.argv[1]?.endsWith("pull-scheduler.ts") ?? false;
if (isMain) {
  loadDotEnv(); // .env for a bare tsx process (Next.js would do this for routes).
  const mode = process.argv.includes("once")
    ? "once"
    : process.argv.includes("fast")
      ? "fast"
      : "loop";
  if (mode === "once") {
    runDuePulls()
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else if (mode === "fast") {
    runFastTick()
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(r.lock.acquired ? 0 : 0);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else {
    startLoop(); // hourly/nightly cadence
    startFastLoop(); // 10-min fast tick + FX (both keep the process alive)
  }
}
