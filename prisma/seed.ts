/**
 * `pnpm db:seed` — bootstrap the dev DB (D-01/D-02, 2026-10-30).
 *
 * Per the product-owner decision this creates ONLY: the workspace, the two
 * Foremost Leads staff users, the `cl_upcurvv` client and the empty ad-account
 * link row for the G1 LIVE account (act_4749960348632164, "Upcurvv-FML", INR).
 *
 * NO leads, NO events, NO fake spend — dummy data was removed in D-02. Real
 * campaigns/ads/daily spend arrive via the G1 pull job (`pnpm jobs:pull` /
 * `POST /api/meta/pull`), and lead-side rows arrive via live G3 (xt.js) and
 * G4 (gateway webhooks) traffic. A 0-lead dashboard is a valid state.
 *
 * Idempotent + real-data-safe: re-running purges only NON-G1 fixture ad
 * trees and NON-cl_upcurvv clients; it never deletes the G1-pulled tree or
 * live lead rows under cl_upcurvv.
 *
 * Usage: `pnpm db:seed` (reads DATABASE_URL from .env; defaults to
 * `file:./dev.db` next to this file).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { bootstrapInto } from "../src/lib/seed";

const here = dirname(fileURLToPath(import.meta.url));

function ensureDatabaseUrl(): void {
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
}

async function main(): Promise<void> {
  ensureDatabaseUrl();
  // Resolve a relative SQLite path against this file's directory so
  // `file:./dev.db` lands in prisma/ regardless of cwd.
  if (process.env.DATABASE_URL?.startsWith("file:")) {
    const rel = process.env.DATABASE_URL.replace(/^file:/, "");
    if (!rel.startsWith(":memory:") && !rel.startsWith("/") && !/^[a-zA-Z]:/.test(rel)) {
      process.env.DATABASE_URL = `file:${join(here, rel)}`;
    }
  }
  console.log(`DATABASE_URL = ${process.env.DATABASE_URL}`);

  const prisma = new PrismaClient();

  // Make sure the schema exists even if the user skipped `db:migrate`.
  try {
    await prisma.user.count();
  } catch {
    console.log("Schema not found — running `prisma db push` first…");
    execSync("npx prisma db push --schema " + JSON.stringify(join(here, "schema.prisma")) + " --accept-data-loss", {
      stdio: "inherit",
    });
  }

  const t0 = Date.now();
  await bootstrapInto(prisma);

  // Prove the post-boot state (the "no fake numbers" rule): counts of what
  // should and should not be here.
  const c = async (m: any, w?: any) => m.count(w ? { where: w } : {});
  const [clients, users, accounts, leads, events, payments, spend, spendInr] = await Promise.all([
    c(prisma.client),
    c(prisma.user),
    prisma.adAccount.findMany({ select: { metaId: true, name: true, currency: true, clientId: true } }),
    c(prisma.lead),
    c(prisma.event),
    c(prisma.payment),
    c(prisma.spend),
    prisma.spend.aggregate({ _sum: { inrSpend: true } }),
  ]);
  console.log(
    `Bootstrapped in ${Date.now() - t0}ms -> clients=${clients} users=${users} adAccounts=${accounts.map((a) => a.metaId).join(",")}`
  );
  console.log(`  leads=${leads} events=${events} payments=${payments} (must all be 0 until live traffic lands)`);
  console.log(`  spend rows=${spend} (G1-pulled real rows only; inrSpend sum=${spendInr._sum.inrSpend ?? 0})`);
  console.log("Bootstrap ready. Run `pnpm dev` — the dashboard shows the Upcurvv account + 0 leads (valid state).");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
