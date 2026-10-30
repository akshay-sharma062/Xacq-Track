// G3 param-audit helper: pull live creative destination URLs for the configured
// ad account and check each for the dynamic-template / UTM markers. Uses the
// G1 token from .env — the value is NEVER printed; only presence + URL text.
import fs from "node:fs";
const env = Object.fromEntries(
  fs.readFileSync(".env","utf8").split(/\r?\n/)
    .filter(l => l && !l.startsWith("#")).map(l => { const i=l.indexOf("="); return [l.slice(0,i), l.slice(i+1).replace(/^["']|["']$/g,"")]; })
);
const token = env.META_ACCESS_TOKEN;
if (!token) { console.log("BLOCKED: META_ACCESS_TOKEN not set"); process.exit(1); }
const v = env.META_API_VERSION || "v23.0";
const acct = (env.META_AD_ACCOUNT_IDS||"").split(",").map(s=>s.trim().replace(/["']/g,"")).filter(Boolean).map(s=>/^act_/.test(s)?s:`act_${s}`);

const PLACE = /\{\{\s*(campaign|adset|ad|campaign_id|adset_id|ad_id)\s*\}\}/;
const UTM = /utm_\w+=/;

let found = 0, withTpl = 0, withUtm = 0, noLink = 0;
for (const ref of acct) {
  let url = `https://graph.facebook.com/${v}/${ref}/ads?fields=id,name,creative{object_story_spec}&limit=100&access_token=${token}`;
  let aFound = 0, aTpl = 0, aUtm = 0, aNoLink = 0;
  while (url) {
    const j = await (await fetch(url)).json();
    if (j.error) { console.log(`${ref}: API error: ${j.error.message?.slice(0,200)}`); break; }
    for (const ad of j.data ?? []) {
      const attach = ad.creative?.object_story_spec?.attachments?.[0] ?? {};
      const link = attach.link ?? attach.url ?? null;
      found++; aFound++;
      if (!link) { noLink++; aNoLink++; continue; }
      if (PLACE.test(link)) { withTpl++; aTpl++; }
      if (UTM.test(link)) { withUtm++; aUtm++; }
      if (link) console.log(`  [${ad.name?.slice(0,40).padEnd(40)}] ${link.slice(0,110)}`);
    }
    url = j.paging?.next ?? null;
  }
  console.log(`\n${ref}: ${aFound} ad(s) | ${aTpl} carry {{template}} | ${aUtm} carry UTM | ${aNoLink} have no readable destination link`);
}
const unreadable = found > 0 && withTpl === 0 && withUtm === 0 && noLink === found;
if (unreadable) {
  console.log(`\nNOTE: ${noLink}/${found} ads expose NO destination URL — this token cannot read creative content (adcreative resolves to id-only, creative object_story_spec returns empty).`);
  console.log("Not a confirmed 'no links on ads' result: provide the ad destination links directly, or a token with creative-content read.");
}
console.log("\nPASS TARGET: >=95% of landing-page ad URLs carry {{campaign.id}}/{{adset.id}}/{{ad.id}} OR UTM.");
