pages:   https://join.upcurvv.com/cll
         (xt.js NOT pasted yet — host confirmed, paste pending)
host:    https://oak-alpha-rewards-workstation.trycloudflare.com
client:  Arpit Sharma         ← [BHARNA: cl_fitness ya cl_iitprep,
                                 Upcurvv ka kiska client hai DB mein]

ad link (1 example):
  - https://join.upcurvv.com/cll

template format:
  [x] {{campaign.id}} / {{adset.id}} / {{ad.id}}   (URL parameters mein added, Kaam B se)
  e.g. https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}

pilot clientIds: Arpit Sharma ← [BHARNA: wahi jo upar client mein]

---

## G3 run result (verified 2026-10-30, through the tunnel)

- **Template ⇄ xt.js compatibility: PASSES.** Your template puts the values
  behind `campaign_id` / `adset_id` / `ad_id` query keys, and xt.js's
  extractor reads exactly those three names. Every delivered ad click carries
  an `ad_id` by construction → the "≥95% carry ad_id or UTM" gate is met by
  construction for this link. Reproducible:
  `node scripts/audit-g3-link.mjs "https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}"`
- **Contract bugs found & fixed while running the check** (commit follows):
  1. xt.js was POSTing to the wrong endpoint + body shape → fixed.
  2. No CORS preflight support on `/api/ingest` → added (`src/lib/cors.ts`).
  3. Verified live: `OPTIONS` → 204 + CORS; exact xt.js POST → accepted,
     touchpoint persisted (`adId` + `utmSource` set, `client=cl_fitness`);
     negative cases 400/404 correct. **105/105 tests pass.**
- **Remaining open item (the one `BHARNA`):** `client` / `pilot clientIds`.
  It says "Arpit Sharma" (owner name) but must be a **DB client id**
  (`cl_fitness` or `cl_iitprep`). This is the only slot the snippet below
  needs before it works.

## Paste-ready snippet for `https://join.upcurvv.com/cll`

Put this in `<head>`. Replace `<CLIENT_ID>` with the DB client id
(`cl_fitness` or `cl_iitprep`) — that's the one `BHARNA` above:

```html
<script src="https://oak-alpha-rewards-workstation.trycloudflare.com/xt.js"
        data-api="https://oak-alpha-rewards-workstation.trycloudflare.com"
        data-client="<CLIENT_ID>"
        defer></script>
```

- `data-api` **is required**: the page is on `join.upcurvv.com` but the API
  is on the tunnel — a cross-origin call. xt.js defaults to same-origin, so
  without `data-api` it would POST to `join.upcurvv.com/api/ingest` (404) and
  silently re-queue.
- `data-client` = the tenant this page belongs to (the `BHARNA` value).
- The CORS preflight for this exact pair (Origin `join.upcurvv.com` →
  tunnel) was verified live: 204 + `Access-Control-Allow-Origin` echoed.

Once pasted and live, the ≥95% gate is re-measured from real
`POST /api/ingest` traffic, not the stored-data snapshot.