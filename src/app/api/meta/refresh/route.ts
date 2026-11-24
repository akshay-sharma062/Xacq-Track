/**
 * Pull-on-refresh (user ask: "every page refresh should pull fresh Meta data").
 *
 *   POST /api/meta/refresh  { client?, adAccount?, force? }
 *
 * The dashboard's client preloader calls this on mount (every browser refresh)
 * and again on its 60 s tick. Server behaviour:
 *
 *   - a SPECIFIC ad account (the dashboard's `adAccount` filter) → a REAL Meta
 *     pull of THAT account, gated by the single-writer pull lock (never
 *     parallelizes with the 10-min tick / manual pull) + a per-key MIN-INTERVAL
 *     throttle so a busy refresh loop doesn't hammer Meta.
 *   - the "All clients / all accounts" aggregate view → no Meta pull on
 *     auto-refresh (pulling every visible account here would take minutes and
 *     hold the preloader open); it re-reads the DB the scheduler already keeps
 *     fresh. `force:true` (the manual "Pull now" button) pulls the G1 default
 *     account instead of nothing.
 *
 * Returns `{ pulled, reason?, tookMs?, dataAsOf }` so the preloader knows
 * whether a real pull ran (show the spinner the whole time) or it just re-read
 * the DB (brief, no long spinner). `dataAsOf` = the max lastPulledAt across
 * the affected account(s) after the pull — the "Data as of" stamp source.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession, resolveClient } from "@/lib/api-utils";
import { can } from "@/lib/session";
import {
  pullAllAccounts,
  normalizeAdAccountRef,
  isSimulateMode,
} from "@/lib/meta/pull";
import { acquirePullLock, releasePullLock } from "@/jobs/pull-lock";

/** Min gap between two REAL auto pulls of the same account (the throttle).
 *  Overridable via REFRESH_PULL_MIN_MS; default 5 min — frequent enough that a
 *  refresh shows live data, gentle enough not to burn Meta quota. */
const MIN_INTERVAL_MS = Number(process.env.REFRESH_PULL_MIN_MS ?? 5 * 60_000);
/** Max time a single refresh-triggered pull may hold the request open.
 *  A Meta pull of a large account can exceed it — the route then returns
 *  `pulled:false` with the exact reason, but the pull KEEPS RUNNING in the
 *  background (lock held until it settles — the single-writer rule still
 *  holds) so the data lands for the next refresh. Override: REFRESH_PULL_MAX_MS. */
const MAX_PULL_MS = Number(process.env.REFRESH_PULL_MAX_MS ?? 90_000);
const lastRealPull = new Map<string, number>(); // "client|account" -> epoch ms

export async function POST(req: NextRequest) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!can(s, "pull_meta")) return NextResponse.json({ error: "forbidden: pull_meta" }, { status: 403 });

  const b = await req.json().catch(() => ({}));
  const force = b.force === true;
  const adAccount =
    typeof b.adAccount === "string" && b.adAccount.trim()
      ? normalizeAdAccountRef(b.adAccount)
      : null;

  // No SPECIFIC ad-account filter: pull the requested client's OWN account(s)
  // (the "all clients" aggregate view has no single owner — it reads the
  // scheduler-fresh DB on auto-refresh; only a forced pull touches Meta).
  if (!adAccount) {
    const client = b.clientId ?? b.client ?? "all";
    if (client !== "all") {
      const seen = await resolveClient(s, client);
      if (seen) {
        const accounts = await prisma.adAccount.findMany({
          where: { clientId: seen },
          select: { metaId: true },
        });
        if (accounts.length > 0) {
          // Per-account throttles: pull only the accounts whose min gap elapsed.
          const due: string[] = [];
          for (const a of accounts) {
            const key = `${seen}|${a.metaId}`;
            const last = lastRealPull.get(key) ?? 0;
            if (force || Date.now() - last >= MIN_INTERVAL_MS) due.push(a.metaId);
          }
          if (due.length > 0) return runRealPull(seen, due, force);
          return NextResponse.json({
            pulled: false,
            reason: "all account pulls within the min gap — DB data shown (force to pull now)",
            dataAsOf: await maxLastPulledAt(seen),
          });
        }
        // The client has no linked ad account yet (or none pulled): honest no-op.
        return NextResponse.json({ pulled: false, reason: "no ad account linked to this client", dataAsOf: await maxLastPulledAt(seen) });
      }
    }
    if (!force) {
      return NextResponse.json({
        pulled: false,
        reason: "all-accounts view: auto-refresh reads the scheduler-fresh DB (force to pull)",
        dataAsOf: await maxLastPulledAt(null),
      });
    }
    // force + no client + no specific account → the G1 default account.
    const g1 = await prisma.adAccount.findUnique({ where: { metaId: "act_4749960348632164" } });
    if (!g1) return NextResponse.json({ pulled: false, reason: "no default account", dataAsOf: await maxLastPulledAt(null) });
    return runRealPull(g1.clientId, [g1.metaId], force);
  }

  // The account the dashboard is displaying: the pull targets ITS owner client
  // (in the "all clients" view the selected adAccount belongs to its own
  // client, not resolveClient("all")). Visibility of that client is enforced.
  const requestedClient = b.clientId ?? b.client;
  const owner = await prisma.adAccount.findUnique({ where: { metaId: adAccount } });
  if (!owner) {
    return NextResponse.json({ pulled: false, reason: `no ad account '${adAccount}' in the DB yet`, dataAsOf: await maxLastPulledAt(null) });
  }
  const client = requestedClient ? await resolveClient(s, requestedClient) : await resolveClient(s, owner.clientId);
  if (!client || client !== owner.clientId) {
    // The account isn't visible to this role (a portal role can't pull
    // another client's account) — or no visible client at all.
    return NextResponse.json({ pulled: false, reason: "ad account not visible to this role", dataAsOf: await maxLastPulledAt(client) });
  }

  // Throttle: two REAL auto pulls of the same account < MIN apart skip Meta
  // (the preloader still re-reads the DB so the numbers are current).
  const throttleKey = `${client}|${adAccount}`;
  const last = lastRealPull.get(throttleKey) ?? 0;
  const now = Date.now();
  if (!force && now - last < MIN_INTERVAL_MS) {
    return NextResponse.json({
      pulled: false,
      reason: `throttled (next auto pull in ${Math.ceil((MIN_INTERVAL_MS - (now - last)) / 1000)} s)`,
      dataAsOf: await maxLastPulledAt(client),
    });
  }

  return runRealPull(client, [adAccount], force);
}

/** The single-writer-gated real Meta pull of one or more accounts.
 *
 *  The response is RACE-D against MAX_PULL_MS (the 90 s refresh cap): a pull
 *  still running at the cap returns `{pulled:false, runningInBackground:true,
 *  reason}` so the preloader can close with an honest note — but the pull
 *  Promise is NOT cancelled: it keeps going and the lock is released when it
 *  SETTLES (never at the cap — the single-writer rule must hold for the whole
 *  Meta→DB write), so the data lands and the next refresh / 60 s tick shows it. */
async function runRealPull(clientId: string, metaIds: string[], force: boolean) {
  const token = process.env.META_ACCESS_TOKEN ?? "";
  const apiVersion = process.env.META_API_VERSION || "v23.0";

  if (!token || isSimulateMode()) {
    // No token / simulate mode: honest no-op (never fakes a pull).
    return NextResponse.json({
      pulled: false,
      reason: "no Meta token (simulate/offline) — DB data is shown",
      dataAsOf: await maxLastPulledAt(clientId),
    });
  }

  // Single-writer rule: NEVER parallelize with the 10-min tick / manual pull.
  const lock = acquirePullLock();
  if (!lock.acquired) {
    return NextResponse.json({
      pulled: false,
      reason: `another pull is running (${lock.reason}) — will pick up its data on next refresh`,
      dataAsOf: await maxLastPulledAt(clientId),
    });
  }

  const pullStart = Date.now();
  // Total: the pull + lock release. Its late settle (after the cap fired) is
  // swallowed — the response is already sent; the data still lands.
  const pullThenRelease: Promise<NextResponse> = (async () => {
    try {
      const { failures } = await pullAllAccounts(prisma, clientId, token, metaIds, apiVersion);
      // Stamp the throttle per account that actually ran (force pulls count too).
      for (const m of metaIds) lastRealPull.set(`${clientId}|${m}`, Date.now());
      const dataAsOf = await maxLastPulledAt(clientId);
      if (failures.length) {
        // An account-level Meta 4xx/403 is recorded, not a crash — report it
        // honestly so the preloader note isn't a fake "updated".
        return NextResponse.json({
          pulled: true,
          failed: true,
          tookMs: Date.now() - pullStart,
          dataAsOf,
          errors: failures.map((f) => `${f.account}: ${f.error}`),
        });
      }
      return NextResponse.json({
        pulled: true,
        tookMs: Date.now() - pullStart,
        dataAsOf,
        message: `pulled ${metaIds.join(", ")}`,
      });
    } catch {
      return NextResponse.json({
        pulled: true,
        failed: true,
        dataAsOf: null,
        errors: ["unexpected pull error — retry on next refresh"],
      });
    } finally {
      releasePullLock();
    }
  })();

  // A forced pull is capped too (the preloader's client-side cap is the UI
  // bound; the background-keep-going behaviour is identical).
  const cap = new Promise<NextResponse>((resolve) => {
    setTimeout(() => {
      void maxLastPulledAt(clientId).then((dataAsOf) =>
        resolve(
          NextResponse.json({
            pulled: false,
            runningInBackground: true,
            maxWaitMs: MAX_PULL_MS,
            reason: `pull still running after the ${Math.round(MAX_PULL_MS / 1000)}s cap — it continues in the background; the data lands on the next refresh`,
            dataAsOf,
          })
        )
      );
    }, MAX_PULL_MS);
  });

  const [won] = await Promise.all([
    Promise.race([pullThenRelease, cap]),
    pullThenRelease.catch(() => {}), // keep the late settle observed (no unhandled rejection)
  ]);
  return won;
}

/** The "Data as of" stamp: max lastPulledAt over the client's account(s). */
async function maxLastPulledAt(clientId: string | null): Promise<string | null> {
  const rows = await prisma.adAccount.findMany({
    where: clientId ? { clientId } : {},
    select: { lastPulledAt: true },
  });
  const t = rows.map((r) => r.lastPulledAt?.getTime() ?? 0).filter((n) => n > 0);
  if (!t.length) return null;
  return new Date(Math.max(...t)).toISOString();
}
