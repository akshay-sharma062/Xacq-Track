/**
 * Prisma client accessor (spec section 8: "boring, well-documented tools").
 *
 * A single lazily-created client, guarded against Next.js hot-reload creating
 * duplicate instances. The generator outputs to `node_modules/.prisma/client`
 * (default) — `@prisma/client` re-exports it.
 *
 * Provider: the schema ships on SQLite for zero-service local dev; flip the
 * datasource provider to "postgresql" + point DATABASE_URL at Supabase/Neon
 * for prod (docs/deploy.md).
 */
import { PrismaClient } from "@prisma/client";
import { ensureSqliteConcurrency } from "./sqlite-pragma";

declare global {
  // eslint-disable-next-line no-var
  var globalPrisma: PrismaClient | undefined;
}

function makeClient(): PrismaClient {
  const client = new PrismaClient({
    log: process.env.PRISMA_LOG === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });
  // Root-cause fix for the intermittent P1017/P1014 500s: put the SQLite dev.db
  // in WAL mode + a bounded busy_timeout so the web app's reads are never
  // blocked by the D-05 10-min tick's writes (the D-04 second-writer hazard).
  // No-op for the Postgres prod datasource. Never blocks boot (fire-and-forget).
  void ensureSqliteConcurrency(client);
  return client;
}

export const prisma: PrismaClient = globalThis.globalPrisma ?? (globalThis.globalPrisma = makeClient());

export { PrismaClient };
export type { Prisma } from "@prisma/client";
