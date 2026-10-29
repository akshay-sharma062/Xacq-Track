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

declare global {
  // eslint-disable-next-line no-var
  var globalPrisma: PrismaClient | undefined;
}

function makeClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.PRISMA_LOG === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
  });
}

export const prisma: PrismaClient = globalThis.globalPrisma ?? (globalThis.globalPrisma = makeClient());

export { PrismaClient };
export type { Prisma } from "@prisma/client";
