# G3 INPUTS — fill these 4 values, then say "G3_INPUTS.md is filled"

Everything else for G3 is already done: final `xt.js` build (4.95 KB, served
at `/xt.js` through the public tunnel), the param-audit helper
(`scripts/audit-ad-urls.mjs`), and the touchpoint monitor. When you fill this
in, Claude re-runs the param audit against YOUR real links and re-measures the
gate against live traffic. No further G3 code is written until these arrive.

Tunnel under test (current, temporary — replaces at G10):
`https://competitive-gilbert-observation-hospitals.trycloudflare.com`
(fill in item 1 with the URL your pages actually call; if it IS the tunnel,
paste that URL here).

---

## 1) xt.js placement + host URL

Where the `<script>` tag was pasted on the pilot landing pages, and the host
URL the script posts to (`API_BASE` in the pasted config).

```
pages:   e.g. foremostleads.in/landing/cloud-consult (list each pilot page)
host:    e.g. https://competitive-gilbert-observation-hospitals.trycloudflare.com
client:  e.g. cl_fitness   (the XACQORA_CONFIG.client value in the pasted script)
```

## 2) Ad destination link(s) — one working ad link per account

The actual landing-page URLs Meta sends clicks to (from Ads Manager → ad
preview → destination URL, or copy the ad's destination field). The G1 token
can't read creative URLs, so these come from you.

```
act_4749960348632164:
  - e.g. https://foremostleads.in/landing/cloud-consult
```

## 3) URL template confirmation

Which dynamic-parameter format the links actually use. Pick one, or list the
mix. This is what `scripts/audit-ad-urls.mjs` matches against.

```
[ ] {{campaign.id}} / {{adset.id}} / {{ad.id}}   (Meta dynamic params)
[ ] {{campaign_id}} / {{adset_id}} / {{ad_id}}
[ ] UTM-only:  utm_source / utm_medium / utm_campaign / utm_content
[ ] mix / not sure
example link showing the format:
  e.g. https://foremostleads.in/landing/cloud?{{campaign.id}}/{{adset.id}}/{{ad.id}}
```

## 4) Pilot client id(s)

Which client(s) this gate runs for (must be real ids in the app, e.g.
`cl_fitness` / `cl_iitprep` from the current data).

```
pilot clientIds: e.g. cl_fitness, cl_iitprep
```

---

## PASS GATE (re-measured after your inputs, ≥95%)

- ≥ 95% of **landing-page leads** carry an `ad_id` or UTM — measured from
  touchpoints/leads actually ingested via `xt.js` after deployment, scoped to
  the pilot clientIds above (stored-data snapshot today: 11/11 = 100%, but 9 of
  11 are seed/replay; only 2 are live).
- Param audit of the links in item 2 against item 3's template format.
