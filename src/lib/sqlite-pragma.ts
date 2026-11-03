/**
 * SQLite concurrency pragmas (root-cause fix for the intermittent 500 the PO
 * sees when the D-05 10-min tick runs as a SECOND Prisma-writer process).
 *
 * THE HAZARD: `dev.db` is a single-file SQLite in the default rollback-journal
 * mode (`journal_mode=delete`). In that mode a write transaction holds the whole
 * file, so a READ issued by the web app (`prisma.user.findFirst()` on `GET /`,
 * `dashboardAll`, …) that lands during a writer's window cannot get the lock
 * and Prisma throws a P1017 socket-timeout / P1014 SQLITE_BUSY. Uncaught in a
 * route handler that is an HTTP 500 — intermittently, which is why a clean
 * steady-state route sweep returns 200 every time.
 *
 * THE FIX: switch the file to WAL mode (readers are never blocked by a writer
 * under WAL — they read the WAL snapshot while the writer appends to it) and
 * set a bounded busy_timeout so a residual writer-vs-writer race waits up to
 * 30s instead of throwing. WAL is persistent at the FILE level, so enabling it
 * once (here, on every process that opens the DB) covers the app AND the
 * `pnpm pull:fast` / `jobs:pull` tick process — the two writers that race.
 *
 * No-op for the Postgres prod datasource (PRAGMA is not Postgres SQL). No data
 * is read or written; `journal_mode`/`busy_timeout`/`synchronous` are
 * connection/file settings only. Idempotent + once-per-process.
 */
import type { PrismaClient } from "@prisma/client";

let ensurePromise: Promise<void> | null = null;

function isSqliteUrl(): boolean {
  // SQLite dev = a `file:` URL; the Postgres prod datasource = `postgresql://`.
  // Only touch the pragmas when we're on SQLite — a PRAGMA on Postgres is a no-op.
  return (process.env.DATABASE_URL ?? "").startsWith("file:");
}

/**
 * Enable WAL + busy-wait on the given connection's SQLite file. Safe to call
 * multiple times (caches a single promise per process). Swallows failures:
 * a pragma hiccup must never break app boot; the worst case is we fall back to
 * the (existing) rollback behavior, not a new crash.
 */
export function ensureSqliteConcurrency(prisma: PrismaClient): Promise<void> {
  if (!isSqliteUrl()) return Promise.resolve(); // Postgres prod: nothing to do.
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    // Every PRAGMA below is run through $queryRawUnsafe: SQLite's `journal_mode = WAL`
    // RETURNs the new mode as a row, so $executeRawUnsafe on it throws
    // "Execute returned results"; $queryRawUnsafe is uniformly safe for both the
    // row-returning (journal_mode) and row-free (busy_timeout / synchronous) forms.
    // Each is best-effort: a pragma hiccup must never break app boot (the worst
    // case is we fall back to the existing rollback behavior, not a new crash).
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL;");
    } catch {
      /* already WAL, or transient — non-fatal */
    }
    // busy_timeout (wait up to 30s on a lock, instead of erroring) +
    // synchronous=NORMAL (WAL-safe, faster fsync). Connection-level; Prisma's
    // SQLite connector is single-connection, so this applies to the client's one conn.
    try {
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 30000;");
    } catch {
      /* best-effort */
    }
    try {
      await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL;");
    } catch {
      /* best-effort */
    }
  })();
  return ensurePromise;
}
