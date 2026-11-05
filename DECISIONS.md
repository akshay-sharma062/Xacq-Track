# DECISIONS — Xacqora Track

Product-owner decisions that change the data model or go-live behaviour,
numbered D-xx. Each records what changed, why, and where it is enforced in
code, so a later reader never has to re-derive it from git history.

---

## D-01 — Ad account is the primary organizing entity (2026-10-30)

**Decision:** the data model is re-centered on the **Meta ad account**. A
client is named after its ad-account owner. Every screen/report filters key
off the ad account (`?client=<id>` AND/OR `?adAccount=<metaId>`), then
campaign → ad set → ad → stage → date.

**Scope:** we start with ONE account — **Upcurvv**
(`act_4749960348632164`, "Upcurvv-FML", INR), the G1 LIVE account.

**Enforced in:**
- `prisma/schema.prisma` — `AdAccount` is the link row
  (`metaId`, `name`, `displayOwnerName`, `currency`, `clientId`, `status`);
  `AdCampaign` / `AdSet` / `Ad` / `Spend` all carry `adAccountId`
  (verified present from the G1 pull — no backfill needed).
- New client `cl_upcurvv` ("Upcurvv", INR) = the single client; 1 client ↔
  1..N ad accounts (spec §4 multi-tenant invariant).
- `src/lib/reports.ts` — `resolveAdAccountId(prisma, clientId, metaId)` maps
  a Meta `metaId` (what a URL carries) to the internal link-row id and verifies
  it belongs to the client; the SPEND-family reports (`funnelReport`,
  `adPerformance`, `wastedSpend`, `metaVsTrack`, `weeklySummary`) accept an
  optional `adAccountId` and narrow to it. Lead-side counts stay
  client-scoped (a lead can be touched by ads from any account).
- `src/app/api/reports/route.ts` — reads `?adAccount=<metaId>` and threads it
  through.
- `src/app/api/session/route.ts` + `Topbar.tsx` — the ad-account filter
  options come from the `AdAccount` link rows (real DB data, not a canned
  list), driving a `?adAccount=` URL param.
- `src/lib/meta/pull.ts` — the pull upsert maintains `displayOwnerName` +
  Meta `account_status` on the link row.

**Why:** a client is "the business that owns an ad account". With one account
today the UI shows it as the only option — the control is real and scales to
N accounts without a schema change.

---

## D-02 — Seed/dummy data purged; dev data = real G1 rows only (2026-10-30)

**Decision:** no seed or dummy data anywhere in dev or reports.

**Enforced in:**
- `src/lib/seed.ts` — `pnpm db:seed` now creates ONLY: the workspace, the two
  Foremost Leads staff users (owner + admin), the `cl_upcurvv` client, and the
  empty `AdAccount` link row for `act_4749960348632164`. NO leads, NO events,
  NO fake spend. Real campaigns/ads/daily spend arrive via the G1 pull job;
  lead-side rows arrive via live G3 (xt.js) / G4 (gateway webhooks) traffic.
- The old rich fixture set (`cl_fitness` / `cl_iitprep` / `cl_trial_saas`,
  12 leads, the 30-day fake USD×84 spend series, `aa_123`/`aa_222` ad trees,
  demo personas) was removed. `dev.db` was re-migrated: the G1 real tree was
  re-parented `cl_fitness → cl_upcurvv` and every seed row purged.
- **A 0-lead dashboard is a valid state.** Post-purge honesty copy: the lead
  list shows "No leads yet — live traffic starts when G3 (xt.js on
  join.upcurvv.com/cll) and G4 (gateway webhooks) are live." No stored-data
  "12/12 100%" snapshot claims anywhere.

**Tests:** `test/helpers.ts` `freshDb()` starts from the tenancy bootstrap,
never lead/event/spend fixtures; `ingest.test.ts` + `reports.test.ts` build
their own ad-tree + lead fixtures (spec §8: replay/fixture-own), not seed
data. `fx-store`/`pull-scheduler` tests use `freshDb({ seed: false })`.

---

## D-03 — G3 gate measured on LIVE traffic only (2026-10-30)

**Decision:** the G3 "≥95% of landing-page leads carry an ad_id or UTM" gate
is measured only on real post-deployment traffic under `cl_upcurvv`. 0 leads
is **not** a gate failure — it is the pre-traffic state. A gate pass requires
some live clicks (≥ ~20) before it is meaningful; until then G3 status is
"AWAITING LIVE TRAFFIC", never "MET". No seed backfill counts toward it.

**G3 handoff:** `G3_INPUTS.md` `client` + `pilot clientIds` = `cl_upcurvv`;
the paste-ready snippet now carries a concrete `data-client="cl_upcurvv"`.

---

## D-04 — Multi-account onboarding: zero-manual, auto client-naming (2026-11-02)

**Decision:** onboarding MORE Meta ad accounts is ZERO-MANUAL — the operator
gives ad-account IDs (`META_AD_ACCOUNT_IDS`), and the app pulls everything else
from the Meta Marketing API: identity (name / currency / `account_status`),
the tenant structure, campaigns, ad sets, ads, creatives, daily spend.

**Client naming rule (per the PO decision of 10-30):** a client is named
after its ad-account owner. So each new account auto-creates one client
`cl_<slugified-account-name>` (e.g. "CardGenius 2" → `cl_cardgenius-2`).
Accounts of one business can later be merged under one client via a
documented merge — **not done now** (today the mapping is provisional 1:1;
the existing G1 mapping `act_4749960348632164 → cl_upcurvv` is NEVER
re-parented).

**Onboarding pipeline (enforced in `src/lib/meta/pull.ts`):**
1. `fetchAccountIdentity(ref)` — read name/currency/status from the API
   (zero manual entry). A 401/403 throws a structured `MetaAccessError`
   carrying Meta's permission name.
2. `resolveOrCreateClientForAccount(ref, …)` — idempotent tenant provisioning:
   existing link row → reuse its client (never re-parent); otherwise create
   `cl_<slug>` + link row. Slug collisions across distinct accounts get a
   ref-tail suffix.
3. `onboardAccounts(refs, token)` — the orchestrator: read identity →
   provision → full `pullAdAccount` per account. One account's 403 is
   isolated (recorded with the exact Meta error + permission, `blocked[]`)
   and the others continue. A BLOCKED account is NEVER reported as
   "onboarded" (the 0-fake-success rule).

**Scheduler** (`src/jobs/pull-scheduler.ts`): `runDuePulls` now (a) pulls
every DB-known (client, adAccount) pair through the fixed mapping, and
(b) onboards any `META_AD_ACCOUNT_IDS` entry that has no link row yet.
Per-account failures are isolated and surfaced with `permission`/`status`
fields so a `BLOCKED: needs <permission>` can be recorded exactly.

**Idempotency + no double-count (found + fixed this ticket):** Meta's
no-range 30-day rollup stamps `day = date_stop`, which ADVANCES each pull.
The `(adMetaId, day)` upsert key therefore STACKED a second overlapping
window on re-pull (G1 grew ₹51,480.77 → ₹115,887.55 = two windows).
`upsertPulled` now does a **SNAPSHOT REPLACE**: it deletes the account's
previous spend snapshot before writing the new one. A re-pull is a no-op on
row counts and never duplicates spend. The pull only reaches the delete
after every API call succeeded, so a failed re-pull can never wipe a good
snapshot. Proven by running the full onboarding twice — counts unchanged.

**Filters:** the `?adAccount=` + Topbar selector stays DB-driven
(`/api/session.adAccounts` lists every accessible account); the dashboard
shows per-account spend / campaigns / ads / leads (0 until G3/G4 traffic —
honest empty state).

**Scope rule:** the 6 new accounts are G1-gate-FREE — no per-account spend
reconciliation week yet (that's G9). This ticket's gate: entities + spend
pulled, reports render, filters work, idempotent, G1 non-regression.

**Live result (2026-11-02, [REVIEW] commit):** all 7 `META_AD_ACCOUNT_IDS`
accessible → 7/7 onboarded, zero `BLOCKED` rows (the token reaches every
account; no permission grants needed). Spot-check vs a *fresh* live `/insights`
read is a same-rolling-window comparison: the G1 account (act_…2164) is exact
**0.000%**; the high-volume accounts show a small Δ **only** when the stored
snapshot's `date_stop` is a few days behind the live 30-day window — re-pulling
advances `date_stop` and the Δ collapses back to 0.000% (verified live 2026-11-02:
Piyush/CardGenius/G1 all 0.000% after the window advanced; residual 1.4–4.0% on the
rows whose `date_stop` had not yet advanced = window lag, not a data error). G1
total is now ₹64,406.78 — a live-window growth (the 30-day
rollup advanced), kept a single window by the SNAPSHOT-REPLACE, still mapped to
`cl_upcurvv`. One AED account ("The Job Workshop") stores native AED with
`inrSpend=0` because the live FX fetch was sandbox-blocked — spec 5.7
backfill, not a fake; making FX real on-machine is Dashboard-V2 §4.

## D-05 — Dashboard V2: All-default view + 10-min autopull + real FX + dense dashboard (2026-11-02)

PO decision 2026-11-02. One decision, four coupled pieces — recorded together
because they ship as one [REVIEW]:

**1. All-clients / All-accounts default (§1).** Every filter + report screen
now defaults to the AGGREGATE view: `?client=` absent or `all` → the whole
visible client set; `?adAccount=` absent → all ad accounts. `resolveClientSet`
(`api-utils`) resolves the set; the dense dashboard (`dashboardAll`) and every
spend-family report (`/api/reports`) aggregate across it — sums for the
additive figures, recomputed rates for cost-per/ROI/ROAS (never sum rates).
Per-client / per-account drill-down is unchanged (a specific `?client=` or
`?adAccount=` scopes to it). Both selectors stay DB-driven — adding account #8
in `.env` makes it appear with zero UI change.

**2. 10-minute fast tick + single-writer lock (§3).** A new `runFastTick()`
refreshes the day's data every 10 min (`pnpm pull:fast`, or the resident
`startFastLoop()`); it re-tries the FX fetch + backfill in the same tick.
Discipline from the idempotency incident: **one pull process at a time** —
`acquirePullLock` (a cross-process file lock, `src/jobs/pull-lock.ts`) makes a
running tick SKIP, never parallelize. A 30-min TTL so a dead holder can't
wedge the pipeline. Lock test included (`test/pull-lock.test.ts`). The 3-hourly
entity tick is folded into the 10-min cadence (recorded call, PO allowed either).

**3. Real multi-source FX + backfill (§4).** `fetchLiveFxRate` tries
`open.er-api.com → frankfurter.dev → exchangerate.host` (each env-overridable,
source recorded on the FxRate row). If all three are unreachable it returns the
exact three error strings — **never a hardcoded rate**. `backfillMissingInr`
re-converts the stored native-only rows (`inrRate=0`) once a rate lands. LIVE
on this machine: AED→INR fetched at **25.849976** (source #1), the "The Job
Workshop" AED account backfilled to **₹384,113.82** INR. (Also fixed a real
`.env` bug: `FX_API_BASE` had a stray inline comment + embedded quotes that
were silently breaking source #1's URL — that was the honest root cause of the
earlier "FX blocked" state.)

**4. Dense dashboard + 60 s auto-refresh (§2/§3b).** The dashboard's default
render is now information-dense off the G1 pulls: aggregate KPI row (per-
currency + INR), 7 per-account cards (last-pulled + spot-check Δ), daily
spend chart, top campaigns, top ads (thumbnail), CAPI send-status strip
(honest 0s until G8), and a sync/FX strip with the "Data as of" stamp. The
client polls `/api/session` every 60 s → server-component refresh (no Meta
calls from the browser). A 0 in the leads-family is labelled
"AWAITING LIVE TRAFFIC (G3/G4)" — honest, not a fake.

**Scope rule:** nothing here deletes a real pull row; seed stays tenancy-only
(D-02 stands). Money display + scheduler paths → [REVIEW].

## D-06 — G4 webhooks per client: host-agnostic routing + per-client signature secret (2026-11-03)

The G4 gate: one inbound webhook URL per client per platform
(`POST /api/webhooks/<platform>?client=<clientId>`) across all 7 D-04 clients,
with the signature/secret verified per client. The route was already
host-agnostic (client via `?client=`, platform via path); G4 makes that **real
and reconciled for every (client × platform) combo**, and adds the per-client
signature secret that the D-05 closeout flagged as the missing wiring step.

**Routing reconciliation (work 1).** `POST /api/webhooks/<platform>?client=<id>`
now proven across **7 clients × 5 G4 payment platforms = 35 routes, 35/35
accepted** (a locally-replayed, correctly-signed provider-shaped event through
the real HTTP route — `scripts/g4-replay.ts`, re-runnable). Each platform's
adapter `verify` ran against the client's `webhookSecret`: Razorpay
(`x-razorpay-signature` HMAC over the raw body), Cashfree
(`cf-signature` HMAC over `${cf-timestamp}:${body}`), Cosmofeed/TagMango/
FlexiFunnels (shared `x-webhook-secret`). A **bad signature 502s** (reject),
not a fake accept. Meta's `hub.challenge` handshake was verified **per client
(7/7 echo the challenge; a wrong token 403s)**.

**Per-client signature secret (the G4 wiring step).** G4 provisions each client
with its own `Client.webhookSecret` (the value the adapter verifies against).
`.env` is NOT the home for it — it lives on the Client row (per-client, per the
D-05 closeout + spec 10). The harness provisions all 7 (values never printed).
No gateway API keys exist in `.env`, so **real provider-side traffic is
BLOCKED** for the 5 G4 platforms (recorded with exact reason per platform,
never faked) — the replay proves the app-side routing/verify/ingest is ready;
only the provider→our-inbound hop awaits a real gateway webhook.

**Bug found + fixed by the G4 replay (the 12/35 that would otherwise 502).**
`OutboundEvent.eventId` is `@unique` and was stored as `dedupKey.slice(0,64)`.
Two CAPI Purchase events for the **same lead across different gateways** share
a `Purchase:<client>:<phone>:<txn…>` prefix, so their 64-char truncations
collided on the `@unique eventId` column → the second `create` 502'd. The send
path keys on `dedupKey` (already `@unique`), so `eventId` is a redundant
idempotency mirror. **Fix (`src/lib/ingest.ts`): store the full, already-unique
`dedupKey` as `eventId` — no truncation.** Regression test
`test/ingest.test.ts` "one lead paying through two gateways …" locks it (both
events land, distinct dedup + event ids). 127/127 tests, build exit 0.

**Dashboard flip (work 3).** A full-funnel replay (Meta lead → registered →
webinar_joined → call_booked → a paid gateway) under a client flips the
leads-family KPIs from 0 ("AWAITING LIVE TRAFFIC (G3/G4)") to live counts. The
flip is real DB reads at request time — the source is stated honestly as
locally-replayed events, not live provider traffic.

**Scope rule:** host-agnostic (the dead quick-tunnel host is a G10 concern, not
G4's — the route works on any host). No G1/D-04 pull row is touched; G4 writes
only ingest rows. Webhook path + CAPI + per-client permission → [REVIEW].


## Pre-step note — G2 Meta Instant Forms = final deferred (PO decision 2026-11-03)

G2 (Meta Instant Forms: `adapters/meta.ts` `meta_form_lead` + the `hub.challenge`
handshake + `/act_…/leadgen_leads`) is **finally deferred, not just skipped**:
the PO confirmed 2026-11-03 that Meta Instant Forms will not be on the
go-live path. The code stays dormant + green (its tests untouched); the
`/act_…/leadgen_leads` 2500-on-probe note stands (LeadGen hangs off a Page,
not an ad account; no Page is wired). No re-gating; if G2 is ever scheduled,
re-open from `GOLIVE_STATUS.md` row "Instant Forms".

## D-07 — G8 CAPI LIVE: per-client Meta pixel (Data Source) mapping (2026-11-03)

The G8 gate (spec 5.8 + Phase-3 acceptance **EMQ>=7 on Purchase**): CAPI events
POST to a client's Meta **pixel / Data Source** — *not* its ad-account id. The
PO supplied the pixel ids keyed by ad-account *names*; reconciled to the 7
onboarded client slugs (live Meta display-name + DB `AdAccount` metadata
cross-checked 2026-11-03; the two Abhishek slugs are **distinct ad accounts**
in the DB, `act_500594992542527` vs `act_1042839737275035`, so the PO's one
shared pixel id for both names is legitimate).

**The mapping** (values live ONLY in `.env` as `META_PIXEL_ID_<CLIENTID-UPPER>`;
key names documented in `.env.example`, reader is `src/lib/meta/pixel-map.ts`):

| PO ad-account name | pixel id | client slug | `.env` key |
|---|---|---|---|
| FML X UPCURVV | 4438125733120237 | `cl_upcurvv` | `META_PIXEL_ID_CL_UPCURVV` |
| the job work shop (FML & The Job Workshop — **default**) | 1336763808671896 | `cl_the-job-workshop-ad-account` | `…_CL_THE_JOB_WORKSHOP_AD_ACCOUNT` |
| the job work shop (Kajabi Landing — **unused-pending-decision**) | 1753137982216053 | same | `…_ALT` (recorded, not wired) |
| FML X Swaraj | 28395623206787014 | `cl_cardgenius-2` | `META_PIXEL_ID_CL_CARDGENIUS_2` |
| FML x Cracckify | 1730094938074293 | `cl_fml-new` | `META_PIXEL_ID_CL_FML_NEW` |
| FML - Abhishek Pal **and** Abhishek Pal - FML (PO wrote the same id for both) | 1020140539575139 | `cl_abhishek-pal-fml` | `META_PIXEL_ID_CL_ABHISHEK_PAL_FML` |
| FML FOR ABHISHEK 2 | 501477182468565 | `cl_fml-x-abhishek-pal` | `META_PIXEL_ID_CL_FML_X_ABHISHEK_PAL` (+ `…_ALT` = the shared `1020140539575139`) |
| — no pixel supplied — | — | `cl_piyush-ahuja` | *none — stays in simulate mode (not a bug; the "lacks a pixel" row in GOLIVE_STATUS)* |

**Send-mode flip (`src/lib/meta/capi.ts` `sendQueue`):** LIVE = a real
Conversions API POST only when BOTH `META_ACCESS_TOKEN` **and** the client's
pixel are present; otherwise SIMULATE (mark sent locally, `simulated=true`, no
network — never a canned live-success). A Meta 4xx/403 = **BLOCKED with the
exact error string** on the row (retried on the next queue run), never a fake
accept. Meta's own **Event Match Quality** is read back per event
(`event_hub_log_view[].event_match_quality`), persisted verbatim
(`OutboundEvent.metaEmq` + `emqFromMeta` true only when Meta reported a usable
number — never mixed with the local heuristic, which is surfaced separately as
"est"), and surfaced on the dashboard CAPI strip (**live vs simulated split**,
Meta-reported avg Purchase EMQ — the G8 acceptance number). The frozen wire
`event_id` = `sha256(dedupKey).slice(0,40)` derived from the row's *stored*
`dedupKey`, so a crash-and-retry re-POSTs the same event_id and Meta dedups —
the "never send twice" rule holds across retries.

**Proof:** `scripts/g8-replay.ts` (`pnpm capi:replay`) pushes ONE synthetic
Conversions API event for a pixel-bearing client through the real send
primitive, clearly labelled **REPLAYED — NOT LIVE TRAFFIC**, capturing Meta
HTTP status + returned event id + Meta's reported EMQ (`.g8-evidence.txt`,
gitignored). **Result 2026-11-04:** the replay returned **Meta HTTP 200**
(fbtrace_id `AoRi_ZmEpa895gB22GnWzRW`) after two wire-shape fixes — Meta 400
subcode `2804019` (event_name required) → standard-name map, and subcode
`2804039` ("action source invalid … such as 'website'") → `action_source`
flipped `system`→`browser`→**`website`** with `event_source_url` set, because
web-originated events require a WEB source. Meta's 200 ack came back **without**
a hub-log `event_id` or EMQ for this synthetic (no G3-matched browser-pixel
traffic yet), so `EMQ≥7 on Purchase` stays gated on real G3 live traffic — not
claimed here. Add-ons: "Meta vs Track" report wiring = **AWAITING G3 live
traffic** (never faked); weekly Monday 9AM IST summary + PDF scheduler =
recorded stub, full PDF is G9/G11.

**Scope rule:** CAPI = money + Meta-gated → **[REVIEW]** commit; PO reviews
before the task is marked done. No pull row is touched; pixels/tokens stay in
`.env` only.

## D-08 — Meta data expansion + date-range filters: API capability matrix (2026-11-05)

**Phase-1 honest probe** (`scripts/meta-probe.ts`, `pnpm meta:probe` — read-only,
one account first: `cl_upcurvv` → `act_4749960348632164`, v23.0; raw findings in
`.meta-probe-findings.txt`, gitignored; **a 400 is a finding, not a failure**):

| area | probe | Meta HTTP | result |
|---|---|---|---|
| (a) account | `GET /act_…?fields=balance,name,currency` | **200** | `balance="218661"` (INR) — G1 never pulled it; **Balance is real** |
| (b) insights | `time_preset` ∈ {yesterday, last_7d, last_30d, last_month, last_year} | 200 | **param IGNORED** — every preset returns the same default 30-day rollup (1 row, `[date_start..date_stop]` ≈ 30d) |
| (b) insights | `date_start`/`date_stop` pairs (7d / 30d / 365d) | 200 | **ignored** — same 30d rollup row back, not the requested window |
| (b) insights | `period=daily` (+ preset) | 200 | **ignored** — `period` is not a valid param on this endpoint/version; no per-day rows |
| (b) insights | `time_range={"since","until"}` | **200 + honored** | the ONE range mechanism that works: `[10-30..11-05]` returned distinct spend (32904.3 vs the 30d 82116.98). G1's 400 was the *empty/malformed* `time_range` ("must be non-empty"); a well-formed one is valid |
| (c) ad + account insights | `fields=lpv`, `fields=clpv`, `fields=lpv,clpv` | **400** `#100 not valid for fields` | **LPV/CLPV do not exist on this API version** → no card, the 400 is recorded (never papered over) |

**Phase-2 build (only what the probe proved):**
- **Per-day storage from presets: SKIPPED** — the conditional "if daily rows
  come back for a preset" is **false** (rows=1, distinctDays=1 for every
  preset/dated call). No per-day Spend rows added; the existing single 30-day
  rollup row per ad stays (fixed point: ad=3808/adSet=1172/spend=3808,
  `fxRate=1` INR intact; WAL journal `f5a641b` stands). `time_range` is
  honored but still returns a *range rollup* (one row per ad), not per-day —
  so it can't feed per-day rows either; recorded here, not built.
- **Balance** (probe (a) passed): `AdAccount.balance` + `balanceAsOf` columns
  (additive `db push`); `pullAdAccount` now fetches `fields=balance`
  **isolated** — a balance 4xx records the exact Meta string (`balanceNote`)
  and never fails the spend pull (the G4 per-account isolation rule); a
  failed fetch never clears the last stored value (card shows "—", not a
  fake 0). Surfaces on the dashboard account cards + the `/meta` card.
- **Dashboard date-range control** (`?range=` + custom `?rFrom/?rTo`):
  Yesterday / 7D / 30D / Last Month / Last Year / Custom. Semantics, per the
  probe: the SPEND family always shows the **stored 30-day rollup** (the only
  per-day data Meta returns — the closest available data), and any range that
  isn't 30d carries the honest label **"30-day rollup only (Meta API limit —
  see DECISIONS D-08)"** — never a sliced/extrapolated number. The LEAD
  family (leads/events/payments, which have real timestamps) is sliced to the
  range. 30d absent-param = byte-identical to pre-D-08 behaviour.
- **LPV/CLPV: NOT built** (probe (c) 400) — no card; the 400 is recorded
  above. **Meta "Leads" is NOT an insights metric on these accounts** (G1
  documented `leads` 400; re-confirmed by the 400-class of (c)): if the PO
  expects a Leads figure, the source is **G2 Instant Forms (deferred)** or
  **G3 live clicks/CAPI Lead events** — recorded here, never faked from
  insights.

**Tunnel host note (host-agnostic rule):** the current quick-tunnel is
`https://vegas-legacy-fully-presenting.trycloudflare.com` → `:3000`
(re-verified live 2026-11-05; the prior `naval-look-noble-sampling` + the
2026-10-30 `oak-alpha-rewards-workstation` subdomains are DEAD — HTTP 000).
Quick-tunnel subdomains change on every cloudflared restart, so all webhook /
ingest / xt.js host references stay **host-agnostic** in code + docs; the
live URL is the current value only. **G10 later swaps this for a stable Vercel
domain** — keep it that way.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **152/152** (was 138; +14 D-08:
range semantics ×5, dashboardAll range-slice ×3, balance persistence ×3,
probe-table regressions ×3) · `pnpm build` 0 · live smoke: `/?range=yesterday|7d|last_year|custom`
all 200 with the rollup label; `/meta` balance card ("— (not pulled)" until
the next real pull). No pull row touched; `.env`/`dev.db`/scratch never
committed.

## D-09 — close the data gaps before live traffic: bulk FX backfill + balance population + G3 snippet (2026-11-05)

**FX backfill gap — HONEST FINDING (the ticket's premise was checked against
the data first, and it did NOT hold):** the live DB showed 3,212 of 3,808
Spend rows with `inrSpend=0`, flagged as "INR-normalised total understated".
A read-only diagnostic (`scripts/fx-diag.mjs` → `.fx-diag.json`, gitignored)
proved all 3,212 zero-rows are **zero-spend placeholders** Meta writes for
ads that had no spend in the pull window (`spend=0` on every one of them;
`moneyGap = 0` rows with `spend>0` and `inrSpend=0`), and a per-row integrity
check found **0 violations** of `inrSpend == round(spend × inrRate, 2)`.
The AED account's positive-spend money was already normalised at the stored
per-day rate (₹14,859.85 AED → ₹384,126.75 INR at 25.849976, matching the
D-05 figure); the recomputed "correct" INR total differed from the stored
total by **₹0.02 (rounding)**, i.e. **no material under-statement**.

**What was still built (the ticket's rule 1, and the durable safety net):**
- `backfillInrZeroRows()` (src/lib/fx-store.ts) — bulk backfill over EVERY
  `inrSpend=0` row: INR rows stamp the 1:1 identity rate (`inrSpend := spend`);
  non-INR rows convert at the per-day stored FxRate, else the currency's most
  recent stored rate, else a live multi-source fetch (persisted on success);
  a currency with no stored rate + all three FX sources unreachable →
  **BLOCKED with the exact per-source error strings**, rows left untouched
  (never a fake rate). Idempotent (re-run = 0 updates); **never deletes
  rows** (update/upsert only).
- `pnpm fx:backfill` (scripts/fx-backfill.ts) — one-time run with the
  idempotency proof built in (run-1 + re-run); evidence → `.fx-evidence.txt`
  (gitignored).
- **Wired into the 10-min fast tick** (`runFastTick` now returns `inrZero`):
  the safety net runs on every tick, so a future pull that lands a native-only
  AED row (rate 0) is re-converted automatically within ~10 min.

**Proof (before/after, 2026-11-05):** zero-row count 3,212 → **0 un-stamped**
(`inrSpend=0 AND inrRate=0`); INR total **3,219,655.33 → 3,219,655.33
(Δ 0.00)** — the backfill STAMPED the 3,212 zero-spend rows (rate consistency,
value unchanged by design), it did not fabricate value; re-run byte-identical
(0 updates). Fixed point untouched: ad=3808 / adSet=1172 / spend=3808; WAL
journal intact. The "INR total was understated by ₹X" claim is **explicitly
not made** — the data showed it was not understated (0.02 paise rounding).

**Balance pull (item 2):** `pnpm pull:once` now populates
`AdAccount.balance` on every successful account pull (the D-08 fetch path).
All 7 accounts return a balance on the read-only `pnpm balance:check`
(`scripts/balance-check.ts`, exact per-account 200/error, no DB writes):
Upcurvv-FML **₹283,383**, Abhishek Pal **₹2,070,383**, FML New
**₹692,084**, FML X Abhishek Pal **₹615,668**, CardGenius 2 **₹350,054**, The
Job Workshop **AED 28,252** (native AED, shown in account currency — not
faked into INR), Piyush Ahuja **₹0** (a legitimate zero balance, distinct
from "— = not pulled yet"). Meta's `balance` is a moving "bill amount due"
— the stored value is Meta's figure at pull time (07:03–07:05 IST, 2026-11-05),
never forced to D-08's earlier probe snapshot (218,661 for Upcurvv-FML).
**Fixed-point disclosure:** the D-09 pull advanced Meta's live ad tree —
ad 3808→**3818** / adSet 1172→**1177** / spend 3808→**3818** (live-tree
growth since the October snapshot, ADDITIVE — no pull row deleted; the
backfill itself is update-only and re-run byte-identical). The account cards
+ `/meta` now show the real Meta balance for pulled accounts, not "—".

**G3 snippet regeneration (item 3):** the xt.js paste-ready snippet in
GOLIVE_STATUS.md was refreshed to the CURRENT live tunnel
`https://vegas-legacy-fully-presenting.trycloudflare.com` (re-verified
HTTP 200 end-to-end 2026-11-05) with `data-client="cl_upcurvv"`. The prior
`oak-…`/`naval-…` subdomains are DEAD (000). Host stays host-agnostic in
code/docs (G10 swaps to the Vercel domain). PO action to make G3 live
traffic + the EMQ≥7 proof happen: **paste the snippet on
join.upcurvv.com/cll, then ~20 real Meta ad clicks.**

**Verification:** `pnpm typecheck` 0 · `pnpm test` **154/154** (+2 D-09
backfill tests: idempotent recover + BLOCKED-exact-errors) · `pnpm build` 0 · live
check: `/` + `/meta` + `/?range=yesterday` + `/xt.js` all 200 · backfill
before/after + re-run evidence above · `pull:once` balance evidence
(read-only DB reads, above). No pull row deleted; `.env`/`dev.db`/scratch
never committed.

## D-10 — client exception fix + ad-set metrics + live range fetch (2026-11-05)

**Re-probe first (committed matrix, redacted):** `pnpm range:probe`
(`scripts/range-probe.ts`, read-only, token redacted; raw findings
`.d10-range-probe.txt`, gitignored). Confirmed against D-08:

| param (v23.0, act_…2164) | HTTP | rows | spend | verdict |
|---|---|---|---|---|
| `time_range` 1d (yesterday) | 200 | 1 | 6,624 | **HONORED** — distinct from 30d |
| `time_range` 7d | 200 | 1 | 34,379.17 | **HONORED** — distinct from 30d |
| `time_range` 30d | 200 | 1 | 82,116.98 | the native rollup |
| `time_range` 365d / 730d | 200 | 1 | 82,116.98 | **CLAMPED** to the 30d value |
| `period=day` + any range | 200 | 1 | (range rollup) | **IGNORED** — still 1 row |
| `time_range` empty / since>until | 400 | — | — | BLOCKED: exact #100 strings |
| ad-level `period=day` + 7d | 200 | 1 | 0.95 | also a rollup, not per-day |

Key conclusion (honest, not guessed): Meta serves a **single range rollup** —
`time_range` is honored as a window filter, but `period=day` is ignored so
**no per-day rows exist to fetch**. Only **yesterday** and **7d** are
distinctly servable (365/730d clamp to the 30d value; last_month/last_year
keep the stored-rollup label, never a faked year).

**Item 1 — client-side exception: reproduce-first, then the real root cause.**
The prime suspect (`RangePicker` calling `useSearchParams` without a
`<Suspense>` boundary → the "should be wrapped in a suspense boundary"
invariant on client-side navigation) is **fixed canonically regardless**:
`RangePickerInner`/`TopbarInner` are wrapped by an exported
`<Suspense>`-wrapping `RangePicker`/`Topbar` (call-site-agnostic; the
`export function` is the wrapper, the `useSearchParams` core is inside).
A headless-Chrome/CDP sentinel repro (`scripts/repro-rangepicker.mjs`,
sentinel + control self-test) on a **clean prod build** showed **0 console
errors** on load + every RangePicker selection — so on the current build
the exception did not reproduce. The real recurring breakage was the
**corrupted `.next` pattern**: a stray `next dev` running next to prod
`next start`, both writing the shared `.next` (dev-cache
`client-development-fallback` chunk → `550.js` + `routes-manifest.json`
ENOENT). Standing rule: **never run `next dev` next to prod**; wiped
`.next` + clean build + `next start` is the fix. **Auto-respawner verdict:
NO config-level respawner found** (no nodemon/watchman/scheduled-task/dev
entry in `.claude/launch.json` — which is now `prod-attach` (url-only), so
it cannot launch dev). The recurring dev chains came from a **manual user
terminal tab** running `pnpm dev`; that tab is user-owned and cannot be
closed from here — flagged for the report.

**Item 2 — ad-set metrics + client scoping.** `adSetPerformance()`
(`src/lib/reports.ts`) builds the per-ad-set table (name, campaign, spend
native + INR, impressions, reach, clicks, CPM = spendInr/impressions×1000,
CPC = spendInr/clicks, ROAS via `aggregateAttribution` where sales exist)
from **stored Spend/AdSet rows ONLY** (never a live call, never an
estimate). **LPV/CLPV are NOT columns** — `LPV_CLPV_NOTE` says
"LPV/CLPV not returned by Meta v23.0 on these accounts (400 on
lpv/clpv fields — D-08/D-10 probe); not shown; cost/LPV is not
guessed." Shown on the dashboard + a `/reports` `ad_set` view.
**Client-scoping bug found + fixed** (`src/lib/dashboard.ts`): the
active-entity KPI counts compared `adAccountId IN clientIds` (a cuid vs a
`cl_…` id — always 0) and creatives scanned ALL clients; now
`activeAdIds` = the client's ACTIVE ad metaIds, and every count is
`clientId IN clientIds`-scoped. Test (client A selected → **zero** client B
ad sets; reverse direction too).

**Item 3 — live range fetch ("filter apply = API hit"), server-only.**
`resolveLiveRange()` (`src/lib/meta/live-range.ts`): a SERVER-ONLY
on-demand insights fetch for `yesterday`/`7d` (never a Meta call from the
browser; the dashboard server component calls it). **Per-account,
per-day cache** in the additive `LiveRange` table (unique
`adAccountId+rangeKey+day`): same day+range **reuses** the row, no
repeated Meta hit (idempotent — a 2nd call = 0 Meta hits, tested). A
Meta 4xx stores the **EXACT error string** as a BLOCKED row (the UI shows
the note, never an empty grid / fake zero); no token = honest skip
(stored-rollup label). INR-normalised via the stored daily FX rate
(`resolveDayRates`; INR = identity). The 30-day Spend rollup fixed point
is **never written to here** (LiveRange is a separate additive table; no
deletes). UI: yesterday/7d show a live strip "live, HH:MM IST" (fresh
<1h) or "cached" for same-day reuse, + a clamped note if Meta served a
narrower window; unservable ranges (last_month/last_year/custom) keep the
honest "30-day rollup only" label.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **161/161** (14 files;
+7 D-10: Suspense-wrap invariant ×2, client-scoping A-vs-B, ad-set
LPV-absent + CPM/CPC math, live-range cache-idempotency, live-range
BLOCKED-exact-string, no-token-skip) · `pnpm build` 0. No pull row
deleted; `.env`/`dev.db`/`.next`/scratch (all `.d10-*`, `.debug-*`,
`.pre-fix-*` now gitignored) never committed.

## D-11 — CAPI 400 "Object with ID 'pixel'": placeholder guard + numeric-pixel send boundary (2026-11-05)

**Root cause (hunted, not guessed):** the literal word `pixel` was **never
in committed code as a value** — G0 had no live CAPI POST at all
(`postOneCapiEvent` + the `graph.facebook.com/<ver>/<pixel>/events` URL
only exist from G8 `ee7c913`; `git log -S'"pixel"'` touches only G8 + G0).
The 15 failed `OutboundEvent` rows are stamped **2026-11-03** (the G4/G8
replay era) and carry a **stale** Meta 400
`"Unsupported post request. Object with ID 'pixel' does not exist"` — that
400 was persisted to `error` back when the pixel value was still the
placeholder word `pixel` (the `.env` numeric values were entered G8-day,
Nov 4; `git log` proves the route/pixel-map have not changed since).
Those rows were **never re-run** after the fix landed, so the CAPI screen
still displayed the old 400s. All 45 rows had `pixelUsed=null`
(`sendQueue` only records `pixelUsed` on success), and every
`Client.metaPixelId` was null — the literal was not in the DB either.
The real defect: **no guard at the send boundary** — any placeholder
(`"pixel"`, too short, empty) could reach Meta again and 400.

**The fix (send boundary, `src/lib/meta/capi.ts`):**
- `isValidMetaPixelId()` — a pixel must be a **numeric string, 6–20 digits**
  (Meta pixel/dataset-id shape). A type predicate, so a valid id narrows
  to `string` for the live URL.
- `sendQueue`: `!token || !isValidMetaPixelId(pixel)` → **SIMULATE** (local
  mark, no network, `simulated=true`, `pixelUsed=null`, an exact note that
  names the rejected value) — a placeholder is never POSTed, and a
  placeholder is never recorded as "the pixel used".
- `postOneCapiEvent`: a **second, belt-and-suspenders guard** rejects a
  non-numeric pixel with a clear, non-network `ok:false` error (this
  primitive is also called directly by `scripts/g8-replay.ts`).
- **Action-source rule (the live re-run's honest next wall):** Meta
  subcode **2804039** on these pixels rejects the non-web `"system"`
  source ("…such as 'website'") — a "website" source REQUIRES
  `event_source_url`, and a source URL is **never fabricated**.
  `toMetaWireEvent` now omits the web-only `user_data` signals
  (`client_ip_address`/`client_user_agent`) on a non-web source (the
  identity match signals `ph/em/fbc/fbp` are kept). And `sendQueue`
  gates the live POST: **no funnel source URL for the client → stay
  SIMULATED with the exact note**, re-activating automatically once the
  client's default Funnel has a landing URL (`eventSourceUrl` is
  injectable, so the rule is unit-tested both ways). The G4-era rows
  have **zero Funnel rows**, so the live CAPI path for this backlog is
  genuinely not unblocked by data yet — that is stated, not papered over.

**Proof (live re-run, 2026-11-05, `pnpm capi:replay` + `POST /api/capi`
for all 7 clients on the prod build):** the `'pixel'` 400 is **gone** —
pixel-bearing clients reach Meta with the numeric `.env` pixel (the error
changed to the subcode-2804039 action-source 400, which carries a
`fbtrace_id` = Meta accepted the pixel in the URL). `cl_piyush-ahuja`
(no pixel key) → 5/5 simulated, no network. The labelled synthetic
replay on `cl_upcurvv`'s real numeric pixel returned **Meta HTTP 200 +
fbtrace_id `Ab_zLGf_…`** (the wire path is proven end-to-end; the 200
carried no hub-log event_id / EMQ — same honest caveat as G8, the
EMQ≥7 bar stays gated on G3-matched traffic). After the action-source
rule landed, the full backlog re-run left **every row in a terminal,
honest state: sent=44 (simulated, exact notes) · skipped=1 · failed=0**,
and **0 rows still carry the literal `'pixel'` error string**.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **169/169** (14 files;
+8 D-11: isValidMetaPixelId, placeholder→simulate no-network,
boundary-reject, .env-numeric-URL flow-through, settings-placeholder
reject, no-URL→simulate note, URL→live POST, web-signals-kept-on-website)
· `pnpm build` 0 · live re-run above. No pull row touched
(fixed point ad=3818/adSet=1177/spend=3818, WAL intact); `.env`/`dev.db`/
`.next`/scratch (`.d11-*` now gitignored) never committed.

**Unblocking the live path (data, not code):** a valid LIVE CAPI POST
needs (a) the numeric pixel — DONE — and (b) a web source URL: the
client's default Funnel `landingUrls` (or an explicit `eventSourceUrl`).
Next gate: **first Funnel landing URL per client → the 39 simulated
rows flip to live Meta 200s automatically on the next queue run**
(alongside G3 live traffic for the EMQ≥7 proof).
