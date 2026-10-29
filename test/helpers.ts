/**
 * Shared test DB helpers: a throwaway SQLite file + Prisma client, schema
 * applied via `prisma db push`, then seeded through the same `seedInto()`
 * the CLI uses. Each call gets its own temp file so test files can run in
 * parallel forks. No temp file is left behind.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { seedInto } from "../src/lib/seed";

export interface TestDb {
  prisma: PrismaClient;
  close: () => Promise<void>;
}

export async function freshDb(opts: { seed?: boolean } = {}): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "xacqora-test-"));
  const file = join(dir, "test.db");
  const url = `file:${file}`;
  process.env.DATABASE_URL = url;

  // Apply the schema to this throwaway DB (fast; idempotent).
  execSync(
    "npx prisma db push --skip-generate --accept-data-loss --schema prisma/schema.prisma",
    { stdio: "ignore", env: { ...process.env, DATABASE_URL: url } }
  );

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();
  if (opts.seed !== false) await seedInto(prisma);

  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
