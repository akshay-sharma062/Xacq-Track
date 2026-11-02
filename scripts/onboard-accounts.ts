/**
 * Multi-account onboarding runner (PO ticket 2026-11-02). Read the G1 token +
 * the operator's ad-account list from .env, then:
 *   Step 1 — print the 7-row identity table (metaId | name | currency | status |
 *            state), a 401/403 marked BLOCKED with the exact Meta error.
 *   Step 2/3 — run onboardAccounts (auto-provision client+link row + full pull)
 *            for every accessible account; print per-account DB row counts +
 *            the G1 non-regression check (act_…2164 still cl_upcurvv).
 *
 * Safe to run TWICE to prove idempotency: a second run's per-account counts
 * must be unchanged (spend upserts on the same day-key).
 *
 * The token is read from .env and NEVER printed.
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  fetchAccountIdentity,
  onboardAccounts,
  normalizeAdAccountRef,
  MetaAccessError,
} from "../src/lib/meta/pull";

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line
    .slice(line.indexOf("=") + 1)
    .replace(/^["']|["']$/g, "")
    .trim();
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  const refs = (env("META_AD_ACCOUNT_IDS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAdAccountRef)
    .filter(Boolean);

  if (!token) {
    console.error("BLOCKED: META_ACCESS_TOKEN not in .env");
    process.exit(1);
  }
  if (refs.length === 0) {
    console.error("BLOCKED: META_AD_ACCOUNT_IDS empty");
    process.exit(1);
  }

  // Prisma loads .env itself and resolves `file:./dev.db` against the schema
  // dir (prisma/dev.db) — same as the scheduler's `pnpm pull:once` path.
  const prisma = new PrismaClient();

  // ------------------------------------------------------------------------
  // Step 1 — identity table (0 manual entry: all values from Meta).
  // ------------------------------------------------------------------------
  console.log("\n=== STEP 1: 7-account identity (read from Meta Marketing API) ===");
  console.log("metaId | name | currency | status | state");
  for (const ref of refs) {
    try {
      const idn = await fetchAccountIdentity(ref, token, apiVersion);
      console.log(`${ref} | ${idn.name} | ${idn.currency} | ${idn.status} | OK`);
    } catch (e: any) {
      const blocked = e instanceof MetaAccessError || e?.status === 401 || e?.status === 403;
      const reason = blocked
        ? `BLOCKED: needs ${e.permission ?? "permission"} (Meta ${e.status ?? "?"}: ${e.message})`
        : `ERROR: ${e?.message ?? e}`;
      console.log(`${ref} | — | — | — | ${reason}`);
    }
  }

  // ------------------------------------------------------------------------
  // Step 2/3 — auto-provision + full pull for accessible accounts.
  // ------------------------------------------------------------------------
  console.log("\n=== STEP 2/3: onboardAccounts (auto client + full pull, idempotent) ===");
  const { onboarded, blocked } = await onboardAccounts(prisma, refs, token, apiVersion);
  for (const b of blocked) {
    console.log(
      `  BLOCKED ${b.metaId}: Meta ${b.status ?? "?"} ${b.permission ? "(needs " + b.permission + ")" : ""} — ${b.error}`
    );
  }
  for (const o of onboarded) {
    const acct = await prisma.adAccount.findUniqueOrThrow({ where: { metaId: o.metaId } });
    const c = await prisma.adCampaign.count({ where: { adAccountId: acct.id } });
    const s = await prisma.adSet.count({ where: { adAccountId: acct.id } });
    const a = await prisma.ad.count({ where: { adAccountId: acct.id } });
    console.log(
      `  PULLED ${o.metaId} -> client=${o.clientId} (${o.name}, ${o.currency}): campaigns=${c} adSets=${s} ads=${a} spendRows=${o.spendRows}`
    );
  }

  // ------------------------------------------------------------------------
  // Verification: per-account spend totals + G1 non-regression.
  // ------------------------------------------------------------------------
  console.log("\n=== VERIFY: per-account spend + G1 check ===");
  for (const o of onboarded) {
    const acct = await prisma.adAccount.findUniqueOrThrow({ where: { metaId: o.metaId } });
    const sum = await prisma.spend.aggregate({
      where: { adAccountId: acct.id },
      _sum: { inrSpend: true, spend: true },
    });
    console.log(
      `  ${o.metaId} (${o.name}): inrSpend=₹${sum._sum.inrSpend ?? 0}${
        o.currency !== "INR" ? ` | native ${o.currency}=${sum._sum.spend}` : ""
      } | client=${o.clientId}`
    );
  }
  const g1 = await prisma.adAccount.findUnique({ where: { metaId: "act_4749960348632164" } });
  if (g1) {
    const g1sum = await prisma.spend.aggregate({
      where: { adAccountId: g1.id },
      _sum: { inrSpend: true },
    });
    console.log(
      `  G1 regression: act_4749960348632164 -> client=${g1.clientId} (expect cl_upcurvv), inrSpend=₹${g1sum._sum.inrSpend ?? 0}`
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
