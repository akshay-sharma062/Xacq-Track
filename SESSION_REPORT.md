# SESSION REPORT — G1 LIVE (Meta: ad accounts + real spend pull)

Date: 2026-10-29 · Engineer: Claude Opus 5 · Commits: c9e80e6 (G1 code) + this commit

## PASS GATE: "Spend per account matches Meta Ads Manager within 1%" — CLEARED
| Check | Our value | Live Meta value | Δ |
|---|---|---|---|
| Ad 52548473352140 (Video 1) | 7,477.24 | 7,477.24 | 0.00% |
| Ad 52548205305940 (Vdo9) | 6,656.77 | 6,656.77 | 0.00% |
| Ad 52548473351940 (Video 2) | 5,199.04 | 5,199.04 | 0.00% |
| **Account total (act_…2164)** | **51,480.77** | **51,480.77** | **0.000%** |

## What went live
- **Real Meta pull** into `prisma/dev.db`: 39 spend rows, 5 campaigns, 15 ad sets,
  39 ad entities with real names (e.g. "Foremost Leads <> Call Booking <> CBO <>
  21 Oct / Cloud / DevOps Audience / Video 1"). INR account ⇒ FX rate 1.0 (1:1).
- **Scheduled firing path verified** via `pnpm pull:once` (the durable platform
  cron is the G10 wiring item; the trigger route `/api/jobs/pull` is ready).
- **FX store**: no live fetch needed for this INR account (correct behavior —
  fetch only happens for foreign-currency accounts).
- Token/IDs verified live: `/me` → Anurag Singh Rathore; 25 ad accounts
  reachable; "Upcurvv-FML" (INR) is the configured account.

## G1 code fixes landed this session (after c9e80e6)
- `pull.ts`: rewrote the real pull to the **verified live shapes** — ad objects
  (`/ads` with adset/campaign/creative expansion) as spend units, per-ad
  `/insights` **without `time_range`** (that param 400s on this account; the
  no-range call returns Meta's default 30-day rollup), valid-field-only set
  (`link_clicks`/`leads`/`purchases` are not valid here — documented proxies),
  `normalizeAdAccountRef` (`act_` prefix + stray-char strip — the real bug that
  404'd the first attempt), `resultsToConversions` for Meta-vs-Track.
- `route.ts` + `pull-scheduler.ts` + `/api/jobs/pull`: re-wired to the new
  signatures; scheduler normalizes refs + de-dups env IDs; both cadence slots
  now pull Meta's 30-day rollup (documented — that's all this API version
  offers on this account).
- `verify-meta-token.mjs`: fixed the earlier false-negative (was using the
  deprecated `accounts` edge; now `adaccounts`), sanitizes token/id hygiene.
- Tests: 105/105 (+normalizeAdAccountRef, +resultsToConversions, cadence suite).

## Honest notes
- **Earlier "0 ad accounts / no access" verdict was wrong** — my first
  diagnostic requested an invalid `/me` field (`app_id`) which made Meta reject
  the whole call. Corrected probe + the live pull both confirm full access.
- Seed accounts act_1234567890 / act_2223334445 → Meta 403 (owner never
  granted ads_read) — correctly isolated, recorded in the pass result.
- Spend rows use `day = date_stop` (2026-10-29) — Meta here only exposes the
  30-day rollup, not per-day series. Day-level granularity would need the
  Marketing API insights with daily breakdown when `time_range` works again;
  tracked as a known limitation, not a blocker for the 1% gate.

## G2 SKIPPED — product-owner decision (2026-10-30)
G2 (Meta Instant Forms) is **SKIPPED-DEFERRED** for the current go-live scope.
Code is left dormant and green (adapter + its replay tests untouched); the
`/act_…/leadgen_leads` 2500 seen during probing is expected (LeadGen hangs off
a Page, not an ad account; no Page is wired). Re-add G2's pass-gate only when
it is scheduled.

**Consequences (recorded):**
- "Lead source mix" report will show **Instant Form = 0%** — expected, not a bug.
- CAPI **Lead** events will come from `form_submit` (xt.js) and CSV imports
  instead of `meta_form_lead` (the ingest pipeline already maps
  `form_submit → Lead`, `registered → CompleteRegistration`; no CAPI change).
- G8 dedup rules unchanged (`event_id` idempotency + never-send-twice).
- G9 checklist: G2's gate ("100% of Instant Form leads land <1 min with ad_id")
  **dropped**; the G2-deferred consequence (Instant Form = 0% in source mix;
  Lead events from form_submit/CSV) noted on G9.

**New gate order:** G3 → G4 → G5 → G6 → G7 → G8 → G9 → G10 → G11.

## What stays BLOCKED (after G2 deferral)
- G4–G7 webhooks (secrets/actions), G8 CAPI EMQ gate, G10 platform.
- Weekly 9AM summary cron + PDF (G9/G11) — pull cadence cron itself is wired,
  just not attached to a platform timer yet.

## Next handoff card
```
STEP G3: xt.js live on landing pages + Meta dynamic URL params (spec §5.1)
YOU PROVIDE:
  1) Confirmation that public/xt.js is pasted into the pilot landing pages
     (Lovable / FlexiFunnels / TagMango / WordPress):
       <script src="<your-host>/xt.js" data-client="<clientId>" defer></script>
     and is loadable at that URL.
  2) In Meta Ads Manager, campaign URL templates use {{campaign.id}} /
     {{adset.id}} / {{ad.id}} — confirm per ad account. Give one working ad
     link per pilot account so I can test the click from a phone.
  3) The clientId(s) to wire on the pilot pages.
CLAUDE DOES: final xt.js build (<10 KB, served at /xt.js, offline queue+retry),
  a param-audit helper that flags ad URLs missing the dynamic params, and a
  live touchpoint monitor (last 50 rows: which carry ad_id/UTM vs not).
VERIFY: click a real ad link on your phone (known visitor_id cookie) →
  page_view + ad_click touchpoints appear with ad_id within <30 s; audit
  shows which ads still lack params.
PASS GATE: "≥ 95% of landing-page leads carry an ad_id or UTM" (measured on
  pilot traffic; the app shows this % live).
BLOCKED-IF: no pasted-script confirmation → I ship the audit + monitor now and
  the 95% measurement stays BLOCKED: needs live landing pages.
```
