/**
 * G1 handoff — one-command Meta token verification.
 *
 * Usage (after dropping a system-user token into .env):
 *   pnpm meta:verify-token
 *
 * What it does (all output is REAL, none of it is simulated):
 *   1. GET /me                  — is the token live? shows the identity.
 *   2. GET /me?fields=adaccounts — the ad accounts the token can actually pull.
 *   3. Live spend read on the configured account (META_AD_ACCOUNT_IDS):
 *      GET /act_…/insights (NO time_range — verified shape, G1 2026-10-29:
 *      this account's insights 400s on every time_range variant, the
 *      no-range call returns the default 30-day rollup).
 *
 * It never prints the token. Errors are shown verbatim from Meta so a
 * bad-scope / expired token is diagnosable without guessing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function env(key) {
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

/** Meta ad-account refs need the act_ prefix; operators paste bare numbers. */
function normalizeAcct(raw) {
  const s = raw.trim().replace(/[^0-9a-z_]/gi, "");
  return /^act_\d+$/.test(s) ? s : s ? `act_${s}` : "";
}

const tokenRaw = env("META_ACCESS_TOKEN");
const token = tokenRaw.replace(/[\s"']/g, ""); // hygiene: strip stray chars (G1 bug)
const apiVersion = (env("META_API_VERSION") || "v23.0").trim();

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
  console.log(`✓ /me             — token live, identity: ${me.name ?? "(unnamed)"} (id ${me.id})`);

  // 2) Accessible ad accounts (G1 fix: /me?fields=adaccounts — NOT the
  //    deprecated `accounts` edge, which silently returns 0).
  const reachable = await get("me", "fields=adaccounts");
  const adAccounts = reachable.adaccounts?.data ?? [];
  console.log(`✓ /me adaccounts  — ${adAccounts.length} account(s) reachable`);
  if (adAccounts.length === 0) {
    console.log("✗ Token is valid but sees NO ad accounts — grant Business access (ads_management) in Business Settings.");
    process.exit(1);
  }

  // 3) Live spend read on the configured account — the G1 "live GET" verify.
  const ids = (env("META_AD_ACCOUNT_IDS").replace(/[^0-9,]/g, "")).split(",").filter(Boolean);
  for (const id of ids) {
    const ref = normalizeAcct(id);
    const acct = await get(ref, "fields=name,currency,account_status");
    console.log(`✓ account ${ref} — "${acct.name}" (${acct.currency}, status ${acct.account_status})`);
    // No time_range: the verified working shape (account's 30-day rollup).
    const insights = await get(`${ref}/insights`, "fields=date_start,date_stop,spend,impressions,clicks");
    for (const r of insights.data ?? []) {
      console.log(`   rollup ${r.date_start} → ${r.date_stop}: spend=${r.spend} ${acct.currency}  impressions=${r.impressions}  clicks=${r.clicks}`);
    }
    if (!(insights.data ?? []).length) console.log("   (no insights rows in the default window)");
  }

  console.log("\nNext: `pnpm pull:once` to run the real pull into the DB,");
  console.log("then spot-check 3 ads against Meta Ads Manager (G1 PASS GATE: within 1%).");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
