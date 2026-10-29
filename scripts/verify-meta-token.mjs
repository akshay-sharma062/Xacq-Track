/**
 * G1 handoff — one-command Meta token verification.
 *
 * Usage (after dropping a system-user token into .env):
 *   pnpm meta:verify-token
 *
 * What it does (all output is REAL, none of it is simulated):
 *   1. GET /me            — is the token live? shows the identity it belongs to.
 *   2. GET /me/accounts   — ad account(s) the token can access (what G1 pulls).
 *   3. For the first account: GET /{acct}/insights?time_range=last_1d
 *      with spend,impressions,clicks — the live-GET the G1 VERIFY step asks
 *      for, shown to you with real numbers.
 *
 * It never prints the token. Errors are shown verbatim from Meta so a
 * bad-scope / expired token is diagnosable without guessing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function env(key) {
  // Read .env minimally (no dotenv dep) — process.env wins if set.
  if (process.env[key]) return process.env[key];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, "..", ".env"), "utf8");
    const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (!line) return "";
    return line.slice(key.length + 1).replace(/^["']|["']\s*$/g, "").trim();
  } catch {
    return "";
  }
}

const token = env("META_ACCESS_TOKEN");
const apiVersion = env("META_API_VERSION") || "v23.0";

if (!token) {
  console.error("✗ META_ACCESS_TOKEN is empty in .env — add the system-user token first.");
  console.error("  (spec 5.7: Business Suite → Security Center → System Users → token with ads_management, business_management, pages_show_ads, pages_manage_metadata)");
  process.exit(1);
}

async function get(path, extra = "") {
  const url = `https://graph.facebook.com/${apiVersion}/${path}?${extra}&access_token=${token}`;
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message ?? res.statusText;
    throw new Error(`Meta ${res.status} on /${path}: ${msg}`);
  }
  return body;
}

try {
  // 1) Token liveness + identity.
  const me = await get("me", "fields=id,name");
  console.log(`✓ /me            — token live, identity: ${me.name ?? "(unnamed)"} (id ${me.id})`);

  // 2) Accessible ad accounts.
  const accounts = await get("me", "fields=accounts{name,id,currency}");
  const adAccounts = accounts.accounts?.data ?? [];
  if (adAccounts.length === 0) {
    console.log("✗ Token is valid but sees NO ad accounts — grant Business access (ads_management) in Business Settings.");
    process.exit(1);
  }
  for (const a of adAccounts) {
    console.log(`  ad account: ${a.name} (${a.id}, currency ${a.currency})`);
  }

  // 3) Live 1-day insights on the first account — the G1 "live GET" verify.
  const first = adAccounts[0];
  const insights = await get(`accounts/${first.id}/insights`, "time_range=last_1d&fields=spend,impressions,clicks,reach,leads");
  const rows = insights.data ?? [];
  console.log(`✓ live insights  — ${first.name} (last_1d):`);
  for (const r of rows) {
    console.log(`    ${r.date}  spend=${r.spend} ${first.currency}  impressions=${r.impressions}  clicks=${r.clicks}  reach=${r.reach}`);
  }
  if (rows.length === 0) {
    console.log("    (no rows for last_1d — account may have no spend today; try `time_range` backfill via the app)");
  }

  console.log("\nNext: put these ad account IDs in .env (META_AD_ACCOUNT_IDS=…)\n        then run `pnpm pull:once` to do the real pull into the DB.");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
