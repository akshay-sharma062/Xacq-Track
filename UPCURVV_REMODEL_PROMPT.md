# XACQORA TRACK — NEW TICKET (insert before finishing G3): Ad-Account-Centered Data + Seed Purge

> Product-owner decision 2026-10-30: the dashboard/screens stay exactly as designed,
> but the DATA MODEL is re-centered: **Meta ad account is the primary organizing entity**.
> Client = named after the ad account owner. All filters (client, ad account, campaign,
> ad set, ad, stage, date) key off the ad account. We start with ONE account:
> **Upcurvv (act_4749960348632164, "Upcurvv-FML", INR)** — the G1 LIVE account.
> No seed/dummy data anywhere in dev or reports.

Execute this ticket BEFORE finalizing G3 (it resolves the open `data-client` question),
then resume G3. Commit with [REVIEW] (touches lead/ingest paths).

## 1. Schema / model changes (record as D-xx in DECISIONS.md)
- `MetaAdAccount` (or existing table) as the link: `{ id, metaId ("act_4749960348632164"),
  name ("Upcurvv-FML"), displayOwnerName ("Upcurvv"), currency ("INR"), clientId,
  status }`. Ad / AdSet / Campaign / Creative / Spend rows all carry `adAccountId`
  (verify they already do from G1's pull; if not, add + backfill the 39 real rows).
- Create the client **"Upcurvv"** (id `cl_upcurvv`, owner name shown = ad account owner):
  1 client ↔ 1..N ad accounts (spec §4 multi-tenant invariant).
- Filter semantics: every screen/report accepts `?client=<id>` AND/OR `?adAccount=<metaId>`;
  with one account today the UI shows it as the only option — the control is real,
  not a fake dropdown of seed clients.
- Remove seed client ids (cl_fitness / cl_iitprep / cl_trial_saas) from the app's data
  paths and UI lists (they are dev fixtures only; `docs/` mentions fine to stay).

## 2. Seed data purge (dev.db ONLY — schema stays)
- Delete all seed rows: leads, events, touchpoints, payments/deals, tasks/notes,
  seed ad/spend rows (anything from `seed.ts`), seed accounts, seed webhooks.
- KEEP: G1-pulled real rows (5 campaigns, 15 ad sets, 39 spend rows for the Upcurvv
  account), the admin user, the new `cl_upcurvv` + ad-account link.
- `pnpm db:seed` → now creates ONLY: admin user + (optionally) empty `cl_upcurvv`
  scaffolding. NO leads, NO events, NO fake spend. Prove it: run seed on a fresh
  DB, print row counts (leads=0, events=0, spend=real-G1-rows only).
- Post-purge dashboard honesty: leads list = empty state "No leads yet — live
  traffic starts when G3 (xt.js on join.upcurvv.com/cll) and G4 (gateway webhooks)
  are live". No 12/12 "100%" snapshot claims anywhere (delete the stored-data
  snapshot lines from GOLIVE_STATUS.md; G3 gate is now measured on LIVE traffic
  only — 0 leads is a valid state).

## 3. G3 handoff unblock (the data-client question)
- Update `G3_INPUTS.md`: `client:` + `pilot clientIds:` = `cl_upcurvv`.
- Final paste-ready snippet now has a concrete value:
  ```html
  <script src="https://<CURRENT-TUNNEL>/xt.js"
          data-api="https://<CURRENT-TUNNEL>"
          data-client="cl_upcurvv"
          defer></script>
  ```
  (use the live oak-alpha subdomain, or whatever the current tunnel prints —
  re-verify the tunnel is alive before issuing the snippet; quick-tunnel
  subdomains die with the process).
- After I paste it on join.upcurvv.com/cll and Meta delivers a real click:
  touchpoint must land with `client=cl_upcurvv` + `adId` non-null. THAT is G3
  pass evidence (no seed backfill allowed to count).

## 4. State updates + verification before commit
- `GOLIVE_STATUS.md`: new row "Ad-account recentering + seed purge" → DONE (commit);
  G1 rows stay LIVE (the Upcurvv account is now the single real source of spend);
  G3 row: data-client resolved, gate = live-traffic-only; G4+ rows unaffected.
- `SESSION_REPORT.md`: next step = "paste snippet (cl_upcurvv) + 1 real Meta ad
  click test on phone".
- Gates re-check: `git status` clean first; `pnpm test` (adjust any test that
  asserted seed fixtures — they should assert real-ad-account fixtures instead);
  `pnpm build`; dashboard boots showing Upcurvv account + real spend + 0 leads.

## 5. BLOCKED-IF / rules
- No touching prod paths (G10 not reached; sqlite still). No new dependencies.
- If any test hard-codes seed ids, rewrite it to fixture-own (spec §8:
  replay tests use saved sample payloads, not seed data).
- Never mark G3 gate on 0 leads: the gate needs ≥ some live clicks (say 20)
  to be meaningful; until then status = "AWAITING LIVE TRAFFIC", not MET.

Done = committed [REVIEW] + snippet with cl_upcurvv + me clicking a real ad on
phone. Then we are in G3-completion, and next gate is G4 (Razorpay/Cashfree
webhooks for cl_upcurvv).
