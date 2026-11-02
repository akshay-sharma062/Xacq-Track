pages:   https://join.upcurvv.com/cll
         (xt.js NOT pasted yet — host confirmed, paste pending)
host:    https://oak-alpha-rewards-workstation.trycloudflare.com
client:  cl_upcurvv   (D-01 recenter: Upcurvv ka client; DB mein `cl_upcurvv` —
                      seed clients cl_fitness/cl_iitprep D-02 mein purged)

ad link (1 example):
  - https://join.upcurvv.com/cll

template format:
  [x] {{campaign.id}} / {{adset.id}} / {{ad.id}}   (URL parameters mein added, Kaam B se)
  e.g. https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}

pilot clientIds: cl_upcurvv

---

## G3 run result (verified 2026-10-30, through the tunnel)

- **Template ⇄ xt.js compatibility: PASSES.** Your template puts the values
  behind `campaign_id` / `adset_id` / `ad_id` query keys, and xt.js's
  extractor reads exactly those three names. Every delivered ad click carries
  an `ad_id` by construction → the "≥95% carry ad_id or UTM" gate is met by
  construction for this link. Reproducible:
  `node scripts/audit-g3-link.mjs "https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}"`
- **Contract bugs found & fixed while running the check** (commit `6feec32`):
  1. xt.js was POSTing to the wrong endpoint + body shape → fixed.
  2. No CORS preflight support on `/api/ingest` → added (`src/lib/cors.ts`).
  3. Verified live: `OPTIONS` → 204 + CORS; exact xt.js POST → accepted,
     touchpoint persisted with `adId` + `utmSource` set; negative cases
     400/404 correct.

## Paste-ready snippet for `https://join.upcurvv.com/cll`

Put this in `<head>`. The `data-client` is now concrete — `cl_upcurvv`
(D-01 recenter; seed clients were purged in D-02):

```html
<script src="https://oak-alpha-rewards-workstation.trycloudflare.com/xt.js"
        data-api="https://oak-alpha-rewards-workstation.trycloudflare.com"
        data-client="cl_upcurvv"
        defer></script>
```

- `data-api` **is required**: the page is on `join.upcurvv.com` but the API
  is on the tunnel — a cross-origin call. xt.js defaults to same-origin, so
  without `data-api` it would POST to `join.upcurvv.com/api/ingest` (404) and
  silently re-queue.
- `data-client` = `cl_upcurvv` (the only client in the post-purge DB).
- The CORS preflight for this exact pair (Origin `join.upcurvv.com` →
  tunnel) was verified live: 204 + `Access-Control-Allow-Origin` echoed.

**G3 pass evidence (D-03):** after you paste it and Meta delivers a real
click, the touchpoint must land with `client=cl_upcurvv` + `adId` non-null.
No seed backfill counts; the gate needs ~20+ live clicks to be meaningful —
until then status is "AWAITING LIVE TRAFFIC", not MET. The stored-data
snapshot claims have been deleted from GOLIVE_STATUS.md.