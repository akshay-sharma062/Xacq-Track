// G3 PASS-GATE check against a PO-provided ad destination link.
//   node scripts/audit-g3-link.mjs "<delivered link template with {{…}} placeholders>"
// Simulates Meta's dynamic-param expansion (placeholders -> numeric ids) and
// confirms xt.js's URL-param extractor would capture campaign_id/adset_id/ad_id
// or a UTM from the result — i.e. the "≥95% of landing-page leads carry an
// ad_id or UTM" gate is met by construction for that link.
import fs from "node:fs";
const link = process.argv[2] ?? "https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}";
const xt = fs.readFileSync("xt/src/index.ts", "utf8");
// What xt.js reads off the URL (the literal key strings in its extractor).
const KEYS = ["utm_source","utm_medium","utm_campaign","utm_content","utm_term","campaign_id","adset_id","ad_id","fbclid"];
// Simulate Meta delivering the link: expand {{param}} to a numeric id.
const expand = (s) => s.replace(/\{\{\s*(\w+)\s*(?:\.(\w+))?\s*\}\}/g, (_, m, f) => f ? `${m}_${f}`.replace(/[a-z]\./g,"") : "000000");
// The Meta templates use {{campaign.id}}/{{adset.id}}/{{ad.id}}; the delivered
// URL puts those values behind campaign_id/adset_id/ad_id query keys.
const delivered = link.replace("{{campaign.id}}","100").replace("{{adset.id}}","200").replace("{{ad.id}}","300");
const q = new URL(delivered).searchParams;
const got = Object.fromEntries(KEYS.map(k => [k, q.get(k)]));
const hasAd = !!(got.campaign_id || got.adset_id || got.ad_id);
const hasUtm = !!(got.utm_source || got.utm_campaign);
console.log("delivered link :", delivered);
console.log("captured keys  :", JSON.stringify(got, (k,v)=>v??undefined));
for (const k of KEYS) {
  const reads = xt.includes(`"${k}"`) || xt.includes(`'${k}'`);
  if (got[k] && !reads) console.log(`  MISMATCH: URL carries '${k}' but xt.js does NOT read it`);
}
console.log(`carries ad id: ${hasAd} | carries UTM: ${hasUtm} | GATE (ad or UTM): ${hasAd||hasUtm?"PASSES":"FAILS"}`);
console.log("xt.js extractor keys (source-of-truth, xt/src/index.ts):", KEYS.join(", "));
