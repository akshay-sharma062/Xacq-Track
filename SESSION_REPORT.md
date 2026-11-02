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

## D-04 multi-account onboarding (2026-11-02) — 7/7 accessible, [REVIEW]
**What landed:** all 7 `META_AD_ACCOUNT_IDS` onboarded with zero manual data entry —
identity read from Meta (name/currency/`account_status`), each auto-provisioned a
client `cl_<slug>`, full-pulled (campaigns→ad sets→ads→creatives→30-day spend
rollup), upserted idempotently. Per-account snapshot (read-only
`scripts/account-snapshot.ts`):

| Account | name | client | currency | campaigns | ads | inrSpend |
|---|---|---|---|---|---|---|
| act_…535 | Piyush Ahuja | cl_piyush-ahuja | INR | 24 | 357 | ₹88,077.73 |
| act_…2164 | Upcurvv-FML | cl_upcurvv | INR | 5 | 60 | ₹64,406.78 |
| act_…169 | CardGenius 2 | cl_cardgenius-2 | INR | 1 | 15 | ₹32,088.97 |
| act_…27 | FML X ABHISHEK PAL | cl_fml-x-abhishek-pal | INR | 88 | 1,565 | ₹969,109.93 |
| act_…035 | Abhishek Pal - FML | cl_abhishek-pal-fml | INR | 69 | 1,273 | ₹1,502,324.63 |
| act_…942 | FML New | cl_fml-new | INR | 11 | 207 | ₹169,967.79 |
| act_…825 | The Job Workshop | cl_the-job-workshop-ad-account | AED | 93 | 331 | native AED (INR backfill pending) |

Global fixed point after a clean idempotency pass: `ad=spend=creative=3808`,
`adCampaign=291`, `adSet=1172`. Two consecutive full onboarding passes produced a
byte-identical snapshot (the harness flagged the second as a `[duplicate]` of the
first) — the no-double-count SNAPSHOT-REPLACE in `upsertPulled` is proven.

**Verification (ticket's checklist):**
- **7-row identity table** — all 7 `OK` (no 401/403 → no `BLOCKED: needs <perm>` rows;
  the token reaches every account).
- **Per-account spot-check** (fresh live `/insights` vs stored,
  `scripts/spot-check-accounts.ts`): top-spend ad on each account, **0.000% Δ on all
  7, worst 0.000%** — PASS GATE ≤1% cleared for every account, not just G1.
- **Idempotency** — two full pulls, row counts unchanged (byte-identical snapshot).
- **G1 non-regression** — `?adAccount=4749960348632164` still `cl_upcurvv`;
  total now ₹64,406.78 (a live-window **growth**, not a re-pull double-count —
  the 30-day rollup advanced; the SNAPSHOT-REPLACE keeps it a single window).
- `pnpm test` **113/113** · `pnpm build` exit 0 · `git status` clean on commit.

**Honest notes:**
- **AED account** (The Job Workshop) stores native AED spend but `inrSpend=0` with
  `fxRate` global=0: the live FX fetch (`open.er-api.com/v6/latest/AED`) was blocked
  in the sandbox, so rows are native-only, flagged-for-backfill (spec 5.7 documented
  fallback). Not a fake success. Fixing FX-on-machine is Dashboard-V2 §4 (next ticket).
- A brief concurrent-writer incident (two `tsx` processes on the same SQLite file)
  was caught and resolved: killed all writers, ran a clean single-writer pass, and
  took before/after read-only snapshots to prove the DB is a fixed point.

## Next step (post D-01/D-02 ad-account recenter + seed purge)
```
NEXT: paste the xt.js snippet on join.upcurvv.com/cll + 1 real Meta ad
click test on phone.

SNIPPET (concrete — cl_upcurvv is now the only client, D-01):
  <script src="https://<CURRENT-TUNNEL>/xt.js"
          data-api="https://<CURRENT-TUNNEL>"
          data-client="cl_upcurvv"
          defer></script>
  (<CURRENT-TUNNEL> = the live quick-tunnel subdomain; re-verify it's up
   before pasting — subdomains die with the cloudflared process.)

WHEN YOU PASTE + Meta delivers a real click:
  - touchpoint must land with client=cl_upcurvv + adId non-null (D-03 pass
    evidence; no seed backfill counts — 0 leads is a valid state today).
  - the ≥95% ad_id/UTM gate is measured on LIVE traffic only; needs ~20+
    live clicks to be meaningful, else status stays "AWAITING LIVE TRAFFIC".

THEN: gate G4 (Razorpay/Cashfree webhooks for cl_upcurvv).
```
