/**
 * `pnpm db:migrate` — idempotent schema bootstrap.
 *
 * Local dev (SQLite, provider default): runs `prisma db push`, which diffs the
 * schema against the file and applies it. It is idempotent — running it twice
 * is a no-op.
 *
 * Production (Postgres/Supabase): switch the datasource provider in
 * schema.prisma to "postgresql", point DATABASE_URL at the DB, and instead run
 * `prisma migrate dev`/`deploy` for versioned migrations under prisma/migrations/.
 *
 * This script just makes `pnpm dev` work with zero services on a fresh clone.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function ensureDatabaseUrl(): string {
  // Load DATABASE_URL from .env (if present) so `prisma db push` can open the
  // SQLite file. In prod the variable is already in the environment.
  let url = process.env.DATABASE_URL;
  if (!url) {
    const envFile = join(here, "..", ".env");
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, "utf8").match(/^DATABASE_URL="?([^"\n]+)"?/m);
      if (m) url = m[1];
    }
  }
  url ??= "file:./dev.db";
  process.env.DATABASE_URL = url;
  return url;
}

function main(): void {
  ensureDatabaseUrl();
  console.log(`DATABASE_URL = ${process.env.DATABASE_URL}`);

  // Resolve the provider so we know where SQLite files live.
  const schemaPath = join(here, "schema.prisma");
  const provider = /provider\s*=\s*"?(\w+)"?/.exec(
    readFileSync(schemaPath, "utf8").split("datasource")[1].split("}")[0]
  )?.[1];
  const relSqlite = /file:(.+)$/.exec(process.env.DATABASE_URL!)?.[1];
  if (provider === "sqlite" && relSqlite && !relSqlite.startsWith(":memory:")) {
    const dbPath = join(dirname(schemaPath), relSqlite);
    const dbDir = dirname(dbPath);
    if (!existsSync(dbDir)) cpSync(dbDir, dbDir, { recursive: true });
  }

  console.log("Running `prisma db push`…");
  execSync(
    "npx prisma db push --schema " + JSON.stringify(schemaPath) + " --accept-data-loss",
    { stdio: "inherit" }
  );
  console.log("Schema applied. Run `pnpm db:seed` next to load the demo data.");
}

main();
