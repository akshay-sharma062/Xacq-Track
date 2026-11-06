// G3 param-audit (G3 prep): pull live creative destination URLs for EVERY
// stored AdAccount row (all 7 onboarded accounts — not just
// META_AD_ACCOUNT_IDS) and check each for dynamic-template / UTM markers.
// READ-ONLY: uses the G1 token from .env — the token is NEVER printed; only
// URL text + ad ids. No write to Meta, no DB write.
//
// Verdict per account (the report that tells the PO WHICH Meta ad URLs to
// fix — the fix itself is Meta-side, manual):
//   PASS "≥95% by construction"        — ≥95% of scanned ads carry a
//                                         {{template}} or UTM marker
//   needs Meta-side URL fix            — <95%: lists the exact ad ids to
//                                         change in Ads Manager
//   UNAUDITABLE                        — the token can read ad rows but NOT
//                                         their destination links (creative
//                                         resolves id-only): neither PASS nor
//                                         FAIL can be claimed; PO supplies the
//                                         links or a token with creative-read.
//
// Run: node scripts/audit-ad-urls.mjs     (from the project root)
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")]; })
);
const token = env.META_ACCESS_TOKEN;
if (!token) { console.log("BLOCKED: META_ACCESS_TOKEN not set"); process.exit(1); }
const v = env.META_API_VERSION || "v23.0";

// G3 prep: iterate EVERY stored AdAccount row (all onboarded accounts), not
// just META_AD_ACCOUNT_IDS. DB read-only; falls back to the env list if the
// DB is unavailable (so the audit still runs on a bare checkout).
function norm(ref) { return /^act_/.test(ref) ? ref : `act_${ref}`; }
let accounts;
try {
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient(); // repo pattern: reads DATABASE_URL from .env
  const rows = await prisma.adAccount.findMany({ select: { metaId: true, name: true, clientId: true } });
  await prisma.$disconnect();
  accounts = rows.length
    ? rows.map((r) => ({ ref: norm(r.metaId), label: `${r.name} (${r.clientId})` }))
    : null;
} catch {
  accounts = null;
}
if (!accounts) {
  accounts = (env.META_AD_ACCOUNT_IDS || "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean).map((ref) => ({ ref: norm(ref), label: ref }));
}
if (accounts.length === 0) { console.log("BLOCKED: no ad accounts (DB + META_AD_ACCOUNT_IDS both empty)"); process.exit(1); }

const TPL = /\{\{\s*(campaign|adset|ad|campaign_id|adset_id|ad_id)[.a-z_]*\s*\}\}/; // {{campaign.id}} / {{campaign_id}} …
const UTM = /utm_\w+=/;

const summary = [];
for (const { ref, label } of accounts) {
  let url = `https://graph.facebook.com/${v}/${ref}/ads?fields=id,name,creative{object_story_spec}&limit=100&access_token=${token}`;
  let scanned = 0, withTpl = 0, withUtm = 0, noLink = 0;
  const noneAds = []; // ad ids with a readable link that has NEITHER marker
  while (url) {
    const j = await (await fetch(url)).json();
    if (j.error) { console.log(`${ref}: API error: ${j.error.message?.slice(0, 200)}`); break; }
    for (const ad of j.data ?? []) {
      const attach = ad.creative?.object_story_spec?.attachments?.[0] ?? {};
      const link = attach.link ?? attach.url ?? null;
      scanned++;
      if (!link) { noLink++; continue; }
      const hasTpl = TPL.test(link);
      const hasUtm = UTM.test(link);
      if (hasTpl) withTpl++;
      if (hasUtm) withUtm++;
      if (!hasTpl && !hasUtm) noneAds.push(ad.id);
      console.log(`  [${String(ad.name ?? "").slice(0, 40).padEnd(40)} ${ad.id}] ${link.slice(0, 110)}`);
    }
    url = j.paging?.next ?? null;
  }

  // Verdict (never a fake PASS): covered = an ad with AT LEAST ONE marker
  // (template OR UTM) in its READABLE destination link — a deduped union, so
  // an ad carrying both is counted once (scanned - noLink - noneAds.length).
  let verdict;
  const covered = scanned - noLink - noneAds.length;
  if (scanned === 0) {
    verdict = "NO ADS READ (permission or empty account) — not a PASS";
  } else if (noLink === scanned) {
    verdict = "UNAUDITABLE: token cannot read creative destination links (adcreative resolves id-only) — supply the links directly or a token with creative-content read; not a confirmed 'no URLs' result";
  } else if (covered / scanned >= 0.95) {
    verdict = "PASS — ≥95% by construction";
  } else {
    verdict = `needs Meta-side URL fix (${covered}/${scanned} = ${(100 * covered / scanned).toFixed(1)}% carry a marker) — ad ids to change in Ads Manager: ${noneAds.length ? noneAds.join(", ") : "(the no-link ads; add a destination URL with {{campaign.id}}/{{adset.id}}/{{ad.id}} or UTM)"}`;
  }
  summary.push({ ref, label, scanned, withTpl, withUtm, noLink, noneAds, verdict });
}

console.log("\n=== PER-ACCOUNT VERDICT (G3 prep, read-only) ===");
for (const s of summary) {
  console.log(`${s.ref}  ${s.label}`);
  console.log(`  ads scanned=${s.scanned} | with {{template}}=${s.withTpl} | with UTM=${s.withUtm} | no readable link=${s.noLink}`);
  console.log(`  verdict: ${s.verdict}`);
}
console.log("\nPASS TARGET: >=95% of landing-page ad URLs carry {{campaign.id}}/{{adset.id}}/{{ad.id}} OR UTM.");
console.log("The fix is META-SIDE (Ads Manager) — this audit is read-only, it never edits a URL.");
