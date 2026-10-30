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
import { pullAllAccounts, normalizeAdAccountRef } from "../lib/meta/pull";
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
  failures: { clientId: string; account: string; error: string }[];
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

  // Every (client, ad account) pair configured in the DB. Meta refs need the
  // `act_` prefix (operators store bare numbers) — normalise on use.
  const pairs = (await prisma.adAccount.findMany({ select: { clientId: true, metaId: true } })).map((p) => ({
    ...p,
    metaId: normalizeAdAccountRef(p.metaId),
  }));
  if (pairs.length === 0) out.skipped.push("no AdAccount rows configured");

  // Env-listed accounts (G1 handoff: the operator's ad account list) attach to
  // the first client that owns one, else the first configured client.
  const envIds = (process.env.META_AD_ACCOUNT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envIds.length && !out.simulateMode) {
    const firstClient = pairs[0]?.clientId ?? "cl_fitness";
    for (const metaId of envIds) {
      const ref = normalizeAdAccountRef(metaId);
      // De-dup against DB-stored accounts (same normalised ref, any client).
      if (!pairs.some((p) => p.metaId === ref)) {
        pairs.push({ clientId: firstClient, metaId: ref });
      }
    }
  }

  if (out.simulateMode) {
    out.skipped.push("META_SIMULATE=1 — scheduler runs the deterministic fixture, not the API");
  }
  if (!token && !out.simulateMode) {
    out.skipped.push("no META_ACCESS_TOKEN — real pull skipped (add it to .env)");
  }

  if (token && !out.simulateMode) {
    for (const p of pairs) {
      try {
        const { results, failures } = await pullAllAccounts(prisma, p.clientId, token, [p.metaId], apiVersion);
        out.ran.push({
          clientId: p.clientId,
          account: p.metaId,
          spendRows: results.reduce((s, r) => s + r.spendRows, 0),
          errors: failures.map((f) => f.error),
        });
        out.failures.push(...failures.map((f) => ({ clientId: p.clientId, account: p.metaId, error: f.error })));
      } catch (e: any) {
        // Isolate one account's failure from the rest (spec: "alert on failures").
        out.failures.push({ clientId: p.clientId, account: p.metaId, error: String(e?.message ?? e) });
        console.error(`[pull-scheduler] ${p.clientId}/${p.metaId}: ${e?.message ?? e}`);
      }
    }
  }

  return out;
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

// CLI entry: `pnpm jobs:pull` → resident loop; `pnpm pull:once` → one pass.
const isMain = process.argv[1]?.endsWith("pull-scheduler.ts") ?? false;
if (isMain) {
  loadDotEnv(); // .env for a bare tsx process (Next.js would do this for routes).
  const mode = process.argv.includes("once") ? "once" : "loop";
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
  } else {
    startLoop(); // keeps the process alive
  }
}
