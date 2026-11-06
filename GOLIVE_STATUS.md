# GO-LIVE STATUS — Xacqora Track

Single source of truth for "what is real vs. dummy". A path is **LIVE** only
when a real-data verification has been shown (commit SHA + output, dated).
Until then it is **MOCK** (seed/simulate/fake) or **BLOCKED: needs X**.

Last updated: G1 LIVE · G2 SKIPPED-DEFERRED · D-01/D-02 recenter+purge DONE · D-04 multi-account onboarding DONE (7/7) · D-05 Dashboard V2 DONE · D-06 / G4 webhooks-per-client DONE (app-side 35/35 routes + per-client signature secret; real-provider hop BLOCKED on gateway keys) · dev tunnel host DEAD (re-verified 2026-11-03) · owner: lead engineer

## Data stores

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Database | `prisma/dev.db` (SQLite) | Post-D-02: only G1 real rows — 1 client `cl_upcurvv`, 1 ad account (Upcurvv-FML), 3 campaigns / 13 ad sets / 39 ads / 39 spend rows (₹51,480.77); **0** leads/events/payments/webhooks | Postgres Mumbai (Supabase/Neon ap-south) + data copy | **LIVE (single-account)** | D-02 migration 2026-10-30 (verified post-state) |
| Seed dataset | `src/lib/seed.ts` | D-02: `pnpm db:seed` creates ONLY tenancy (workspace, 2 staff users, `cl_upcurvv`, empty ad-account link row) — no fake leads/spend | Real pilot data via G3 xt.js + G4 webhooks | **DONE (seed purged)** | Fresh-DB proof: leads=0, events=0, spend=G1 rows only |
| **Ad-account recentering + seed purge** | `DECISIONS.md` D-01/D-02 | `AdAccount` = organizing entity (`displayOwnerName` + `status` columns); G1 tree re-parented `cl_fitness → cl_upcurvv`; `?adAccount=<metaId>` filter wired through reports + Topbar; all seed client ids removed from data paths/UI | — | **DONE** | D-01/D-02 (commit this change) |

## Meta (spec §3, §5.2, §5.7, §5.8)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Multi-account onboarding | `scripts/onboard-accounts.ts` + `onboardAccounts` in `pull.ts` | **LIVE 7/7 accessible** 2026-11-02: all 7 `META_AD_ACCOUNT_IDS` identities read (6 INR + 1 AED "The Job Workshop"), each auto-provisioned a client `cl_<slug>` (G1 `cl_upcurvv` preserved, never re-parented) and full-pulled. Per-account spot-check vs fresh live insights is a **same-rolling-window** comparison: G1 exact 0.000%; high-volume accounts show a small Δ **only** when the stored snapshot's `date_stop` lags the live 30-day window — re-pulling advances it and the Δ collapses to 0.000% (verified live 2026-11-02: Piyush/CardGenius/G1 0.000% after advance; residual 1.4–4.0% = window lag, not a data error). Idempotency proven — two consecutive full passes gave a byte-identical snapshot (`ad=3808`, global fixed point). AED account stores native spend with `inrSpend=0` (live FX fetch blocked in sandbox — honest, not faked; spec 5.7 backfill). No 403/permission blocks this run. | Durable scheduler `runDuePulls` covers all 7; per-account 403 isolation + lock-in tested (`test/onboard.test.ts`, 403-mid-batch + idempotency) | **LIVE (7/7 accessible)** | D-04 + G1 evidence below; spot-check table in `scripts/spot-check-accounts.ts` |
| Ads pull (spend/entities) | `src/lib/meta/pull.ts` | **VERIFIED LIVE** 2026-10-29: real pull on act_…2164 ("Upcurvv-FML", INR) → 39 spend rows, real campaign/adset/ad names; 3-ad spot-check vs fresh live reads **0.00% each**, account total ₹51,480.77 **exact** (PASS GATE ≤1% cleared). Key findings baked into code: ad accounts need the `act_` prefix (`normalizeAdAccountRef`); this account's insights `time_range` param 400s, so the pull uses the no-range 30-day rollup; per-ad `/ads` objects are the spend units; `time_range`/`link_clicks`/`leads` are not valid here → documented proxies | Live pull via `pnpm pull:once` + scheduler + `POST /api/meta/pull` | **LIVE** | G1 evidence below: 39 rows, 0.00% Δ, seed accounts 403-isolated correctly |
| FX rate (multi-currency→INR) | `src/lib/fx-store.ts` + `FxRate` table | **Stored daily rate, multi-source live fetch + persisted, then backfilled** (spec 5.7 + D-05 §4): `fetchLiveFxRate` tries `open.er-api.com → frankfurter.dev → exchangerate.host` (source recorded on the row; all-unreachable → exact 3 error strings, never a fake rate); `backfillMissingInr` re-converts native-only rows once a rate lands; **D-09: `backfillInrZeroRows` bulk-stamps EVERY `inrSpend=0` row (INR 1:1, non-INR at the stored per-day rate; BLOCKED with exact source errors if none) and runs on every 10-min fast tick + `pnpm fx:backfill` one-time**; `resolveDayRates` feeds every pull | Live rate verified + `pnpm fx:backfill` (idempotent; re-run byte-identical) | **LIVE (multi-source + bulk backfill, all rows stamped)** | 2026-11-03: **AED→INR 25.849976** fetched; "The Job Workshop" backfilled → **₹384,113.82** INR. **D-09 (2026-11-05) honest finding:** the "3,212 `inrSpend=0` rows understate the INR total" premise did NOT hold on inspection — all 3,212 are zero-spend placeholders (`spend=0`, `moneyGap=0`, 0 integrity violations; AED money already normalised at 25.849976). The bulk backfill STAMPED them (un-stamped rows 3,212→0) with **INR total Δ 0.00** (no value fabricated) and is now the durable safety net; evidence in `.fx-evidence.txt`/`DECISIONS D-09`. Also fixed a real `.env` bug (`FX_API_BASE` stray comment breaking source #1). |
| Pull scheduling | `src/jobs/pull-scheduler.ts` + `POST /api/jobs/pull` | Nightly 02:00 + 07/10/13/16/19/22, pure `cadenceForHour` (tested); resident loop `pnpm jobs:pull` + durable cron trigger with `CRON_PULL_SECRET`; idempotent upserts; **live firing verified** — `pnpm pull:once` ran the real pull end-to-end (39 rows). Note: Meta insights on this account only expose the 30-day rollup, so both slots pull the same rollup (documented in scheduler) | Platform cron in prod (Vercel/host) | **LIVE** (firing verified once manually; durable cron not yet wired to a platform timer) | G1 — `pull:once` real pass, cadence tests green |
| Instant Forms | `adapters/meta.ts` + `api/webhooks/[platform]` | Adapter + hub-challenge handshake implemented; not subscribed to any real Page | SKIPPED-DEFERRED. Product-owner decision 2026-10-30: Meta Instant Forms deferred. Code dormant, not on go-live path. Re-add its pass-gate only when G2 is scheduled. (The `/act_…/leadgen_leads` 2500 seen during probing is EXPECTED — LeadGen hangs off a Page, not an ad account; no Page is wired. Existing `meta_form_lead` adapter + its tests are left dormant and green, untouched.) | — | **SKIPPED-DEFERRED** | G2 deferred (PO decision 2026-10-30) |
| CAPI send | `src/lib/meta/capi.ts` + `meta/pixel-map.ts` | **LIVE 2026-11-04:** per-client pixel mapping (`pixelForClient` reads `META_PIXEL_ID_<CLIENT>`; value-free — no pixels in code). `sendQueue` flips to a **real Conversions API POST** when BOTH `META_ACCESS_TOKEN` + a client pixel are present; no token ⇒ honest local mark (`simulated=true`), never faked. Wire: SHA-256 hashed `ph`/`em`, `fbc`/`fbp`, frozen `event_id` dedup, retry queue; EMQ read back from Meta `event_hub_log_view[].event_match_quality` and **persisted verbatim** (`metaEmq`/`emqFromMeta`, `emqFromMeta=true` only when Meta returned it — never invented). Web-originated events send `action_source:"website"` + `event_source_url` (Meta 400 subcode 2804039 dictated "website", not "browser"/"system"); Meta 4xx/403 ⇒ row `failed` with the **exact Meta error string** (BLOCKED, retriable). Proof: `pnpm capi:replay` pushed one labelled synthetic high-signal Purchase for `cl_upcurvv` through the real `postOneCapiEvent` path → **Meta HTTP 200 + fbtrace_id `AoRi_ZmEpa895gB22GnWzRW`** (appended to `.g8-evidence.txt`, gitignored). Honest caveat: Meta's 200 ack came back **without** a hub-log `event_id` or an EMQ value for this synthetic (no G3-matched browser-pixel traffic), so `EMQ≥7 on Purchase` remains gated on real G3 live traffic — not claimed here. `cl_piyush-ahuja` has no pixel key ⇒ stays simulate. 12 CAPI live-path tests (mocked Meta HTTP + dedup re-run + refund-guard regression) green. | `META_ACCESS_TOKEN` + per-client pixel envs | **LIVE (Meta 200 ack on labelled replay; EMQ≥7 awaits G3 live traffic)** · `cl_piyush-ahuja` still simulate | G8 · D-07 |
| **Dashboard V2 (D-05)** | `dashboard.ts` `dashboardAll` + `page.tsx` + `AutoRefresh.tsx` | All-clients/All-accounts **default** view, dense off the G1 pulls: aggregate KPI row (per-currency + INR), 7 per-account cards (last-pulled stamp), daily-spend chart, top campaigns/ads, CAPI strip, sync/FX strip; **60 s auto-refresh** (client polls → server refresh, no Meta calls from the browser); a leads-family 0 is labelled "AWAITING LIVE TRAFFIC (G3/G4)" | Live DB reads at request time | **DONE (All-default + dense dashboard)** | D-05 · 2026-11-03 |
| **10-min autopull + single-writer lock (D-05 §3)** | `src/jobs/pull-scheduler.ts` `runFastTick` + `src/jobs/pull-lock.ts` | 10-min fast tick (`pnpm pull:fast` / resident `startFastLoop`) refreshes the day's data + re-runs FX backfill; a **file lock** makes a running tick skip, never parallelize (30-min TTL so a dead holder can't wedge it); the 3h entity tick is folded in | Durable scheduler + platform cron | **DONE (lock + fast tick, tested)** | D-05 · two-tick idempotency + lock test (`test/pull-lock.test.ts`) |
| **Meta data expansion (D-08)** | `scripts/meta-probe.ts` + `src/lib/meta/pull.ts` + `src/lib/dashboard.ts` | **HONEST API PROBE first, then build-only-what's-proven.** Probe (read-only, `pnpm meta:probe`, findings in `.meta-probe-findings.txt` — a 400 is a finding, not a failure): (a) `balance` = **200** (G1 never pulled it); (b) `time_preset` all-5 / `date_start`+`date_stop` / `period=daily` all 200 **but IGNORED** (same 30-day rollup row back — no per-day); `time_range` (well-formed) = the ONE honored range param; (c) `lpv`/`clpv` = **400** at ad + account level. **Built:** Balance stored (`AdAccount.balance/balanceAsOf`, additive) + shown on account cards + `/meta` (isolation: a balance 4xx never fails the pull, never clears last value); **per-day pull SKIPPED** (no preset returned per-day rows — the conditional was false, not faked); dashboard **date-range control** (Yesterday/7D/30D/Last Month/Last Year/Custom) slices the lead family to the range, the spend family shows the closest available (30-day rollup) with the honest **"30-day rollup only (Meta API limit — see D-08)"** label, never an extrapolated number. LPV/CLPV: **no card** (400 recorded). Meta "Leads" is NOT an insights metric here (G1 `leads` 400; re-confirmed) — source = G2 Instant Forms (deferred) or G3 clicks; recorded, not faked. | `pnpm meta:probe` · `pnpm pull:once` (balance now in every pull) · `/?range=…` | **DONE (probe-proved scope only; balance pulls on next real pull)** | D-08 · 2026-11-05 · `pnpm test` 152/152 (+14) · `pnpm build` 0 |
| **Date-range filters (D-08)** | `src/lib/dashboard.ts` `resolveSpendRange` + `RangePicker.tsx` | Dashboard date-filter control: Yesterday / 7D / 30D / Last Month / Last Year / Custom range — applies to the KPI row, daily-spend chart and account cards, computed over stored Spend rows; for a range the API probe couldn't fetch (anything but the native 30d), shows the closest available data with the honest label **"30-day rollup only (Meta API limit)"** — **never** extrapolates or fakes a number | `?range=` + `?rFrom/?rTo` (custom) | **DONE** | D-08 · `.meta-probe-findings.txt` (probe matrix) · range tests |
| **Account balance card (D-08/D-09)** | `pull.ts` `fetchAccountBalance` → `AdAccount.balance/balanceAsOf` → dashboard cards + `/meta` | **LIVE 2026-11-05 (D-09):** every successful `pnpm pull:once` fetches `GET /act_…?fields=balance` (probe-proven 200, D-08) and persists it; a balance 4xx is isolated (never fails the pull, never clears the last value → card shows "— (not pulled)", not 0). `pnpm balance:check` (`scripts/balance-check.ts`) is a read-only per-account 200/error verifier. 2026-11-05: **all 7 accounts returned a live balance** — Upcurvv-FML **₹283,383** · Abhishek Pal **₹2,070,383** · FML New **₹692,084** · FML X Abhishek Pal **₹615,668** · CardGenius 2 **₹350,054** · The Job Workshop **AED 28,252** (native, shown in account currency) · Piyush Ahuja **₹0** (legitimate zero, distinct from "not pulled"). Meta's `balance` is a moving "bill amount due" — the stored value is Meta's value at pull time, not a frozen number. | `pnpm pull:once` / 10-min tick · `pnpm balance:check` | **LIVE (7/7 balances populated)** | D-08/D-09 · read-only DB evidence + balance:check output |
| **G3 xt.js snippet host (D-09) + per-client table (G3 prep → close-out)** | `GOLIVE_STATUS.md` snippet block | **Host re-verified at the G3 close-out (2026-11-06/07): `https://docs-reserve-inside-parking.trycloudflare.com` is STILL the running quick-tunnel** (no cloudflared rotation this session — `/` 200 + `/xt.js` 200, 5,078 B, byte-identical to `public/xt.js`; `vegas-…`/`oak-…`/`naval-…` dead = 000). The single upcurvv-only block is the **PER-CLIENT table** (all 7 clients; shared `affluentindianshub.com/vpaxdvju` page = no silent single-client pick — a client hint or page split is the PO's decision, recorded in DECISIONS G3 close-out; `cl_piyush-ahuja` = "no landing page supplied" → out of G3 live-traffic scope, honest not a gap). Host-agnostic rule kept: the live subdomain is the *current value only*; G10 swaps to the Vercel domain, no host is hard-coded in code. | PO pastes each snippet + drives ~20 real Meta ad clicks + re-runs `pnpm g3:measure` | **READY (7-client snippets + re-verified host) → PRE-CLICK AWAITING LIVE TRAFFIC (close-out baseline: 0 live clicks, 95% gate + EMQ≥7 unmet-by-absence, not faked)** | D-09 + G3 prep + G3 close-out · next gate = G3 live clicks → real EMQ≥7 + 95% proof |
| **Ad-set metrics + client scoping (D-10)** | `src/lib/reports.ts` `adSetPerformance` + `sumAdSets` + `src/lib/dashboard.ts` + `page.tsx` + `ReportSwitcher.tsx` `ad_set` | Per-ad-set table (name, campaign, spend native + INR, impressions, reach, clicks, CPM, CPC, ROAS where sales exist) built from **stored Spend/AdSet rows ONLY** (never a live call, never an estimate). **LPV/CLPV are NOT columns** — `LPV_CLPV_NOTE` = "LPV/CLPV not returned by Meta v23.0 on these accounts (400 on lpv/clpv — D-08/D-10 probe); not shown; cost/LPV is not guessed" (a zero-column or a guessed cost/LPV would be a fake number). **Client scoping fixed**: selecting a client restricts EVERY block (KPIs, accounts, ad sets, campaigns, ads, CAPI); the active-entity count bug (`adAccountId IN clientIds` = cuid vs `cl_…`, always 0; creatives scanned all clients) is now `clientId IN clientIds`-scoped — **test: client A selected shows zero client B ad sets** (and the reverse). | `/?client=<id>` · `/reports?key=ad_set` | **DONE (stored-rows only; LPV absent by probe)** | D-10 · client-scoping A-vs-B + ad-set LPV-absent tests |
| **Live range fetch — server-only (D-10)** | `src/lib/meta/live-range.ts` + `LiveRange` table + `dashboard.ts` + `page.tsx` | "Filter apply = API hit", SERVER-ONLY: a `yesterday`/`7d` on-demand insights fetch the dashboard server component triggers (never a Meta call from the browser), **per-account, per-day cached** (additive `LiveRange` rows, unique `adAccountId+rangeKey+day`; same day+range reuses → no repeated Meta hit, idempotent, tested). A Meta 4xx stores the **EXACT error string** as a BLOCKED row (UI shows the note, never an empty grid / fake zero); no token = honest skip. INR-normalised via the stored daily FX rate. The 30-day Spend rollup fixed point is **never written to here** (separate additive table, no deletes). Re-probe (`pnpm range:probe`) confirmed only **yesterday/7d** are servable (365/730d clamp to 30d; `period=day` ignored → Meta serves one range rollup, not per-day rows); unservable ranges keep the "30-day rollup only" label, never a faked year. UI shows "live, HH:MM IST" (fresh <1h) / "cached" + a clamped note. | `/?range=yesterday&client=<id>` · `/?range=7d` | **DONE (server-only, per-day cache, BLOCKED-exact, no Spend writes)** | D-10 · cache-idempotency + BLOCKED-exact-string + no-token-skip tests |
| **CAPI send-boundary guard (D-11)** | `src/lib/meta/capi.ts` `isValidMetaPixelId` + `sendQueue` + `postOneCapiEvent` + `src/lib/capi.ts` `toMetaWireEvent` | The `'pixel'`-placeholder 400 (`"Object with ID 'pixel' does not exist"`, the stale G4-era string on the Nov-3 `OutboundEvent` rows) is **eliminated at the send boundary**: a pixel must be a **numeric string (6–20 digits)** — validated in `sendQueue` AND `postOneCapiEvent` (the shared primitive `g8-replay` uses); an invalid/placeholder pixel → **SIMULATE** (local mark, no network, exact note, `pixelUsed=null`) — a placeholder can never reach Meta again, and never records itself as "the pixel used". **Action-source rule (live re-run's honest next wall):** Meta subcode **2804039** on these pixels rejects the `"system"` source ("…such as 'website'"); a "website" source REQUIRES `event_source_url` and a URL is never fabricated → a live POST now ALSO requires the client's funnel source URL (or an injected one); without it the row stays **SIMULATED with the exact note** (Meta-invalid events are never POSTed, so no 400 loop). `toMetaWireEvent` drops the web-only `user_data` signals (`client_ip_address`/`client_user_agent`) on a non-web source (identity signals `ph/em/fbc/fbp` kept). **Proof 2026-11-05:** full 7-client re-run → **0 rows carry the `'pixel'` error**; OutboundEvent = sent 44 (simulated, exact notes) · skipped 1 · **failed 0**; the labelled replay on `cl_upcurvv`'s numeric `.env` pixel returned **Meta HTTP 200 + fbtrace_id `Ab_zLGf_…`** (the pixel resolves to Meta; the 200 carries no hub-log event_id/EMQ — same honest G8 caveat, EMQ≥7 stays gated on G3-matched traffic). | `POST /api/capi` · `pnpm capi:replay` | **DONE (placeholder impossible; live path = valid pixel + a source URL)** | D-11 · 8 new regression tests (placeholder→simulate, boundary-reject, .env-numeric-URL, no-URL→simulate-note, URL→live POST, web-signals-kept) | D-11 · SUPERSEDED by D-12 (the source URL now comes from `.env`, not a Funnel row — the 39 simulated rows are LIVE since D-12) |
| **Dashboard engagement KPIs (D-12)** | `src/lib/dashboard.ts` `EngagementKpis.cpc` + `src/app/page.tsx` KPI row | KPI row added (All-aggregate + per-client views): **Total Impressions · Total Reach · Total Clicks · CTR · CPC**, computed ONLY over the same stored Spend rows the spend KPIs use (same range + client + `?adAccount=` filters — no new Meta calls, no new DB writes). Impressions/reach/clicks are currency-agnostic; CTR (clicks/impressions) + CPC (spendInr/clicks) follow the spend KPIs' INR display; exact math unit-tested (All / single-client / per-ad-account scopes). Live 2026-11-05: **2,73,65,855 imp · 1,52,04,026 reach · 2,74,812 clicks · CTR 1.0% · CPC ₹12**. **LPV/CLPV + cost-per-LPV: NOT added** (Meta v23.0 400s `lpv`/`clpv` on these accounts — D-08 probe); an honest footnote renders below the KPI row ("not shown; no cost/LPV is guessed"), never a zero column. | `/` · `/?client=<id>` | **DONE (stored-rollup KPIs; LPV absent by probe)** | D-12 · 4 new tests (All/single-client/ad-account + CTR/CPC math + LPV-absent + footnote) |
| **CAPI live — event_source_url from .env (D-12)** | `src/lib/meta/pixel-map.ts` `eventSourceUrlForClient` + `META_EVENT_SOURCE_URL_ENV_KEYS` + `src/lib/meta/capi.ts` `sendQueue` (3-tier URL resolution + simulated-row promotion) | **LIVE 2026-11-05 (6 clients):** D-11's blocker (these Meta pixels only accept a web `"website"` source + `event_source_url`, subcode 2804039) unblocked **without Funnel rows (D-02 stands)** — PO-supplied landing URLs live in `.env` as `META_EVENT_SOURCE_URL_<CLIENT>` (gitignored; code is value-free, key names in `META_EVENT_SOURCE_URL_ENV_KEYS`; a value is only accepted when it is a real http(s) URL — a placeholder is never POSTed). URL tiers: injected → `.env` → Funnel `landingUrls`; none → stays SIMULATED with the exact note. **D-12 promotion:** rows D-11 left simulated are re-queued on the first run where a URL exists (their FIRST Meta send; the frozen event_id dedups any repeat). `POST /api/capi` re-run 2026-11-05: **cl_upcurvv 14/14 · cl_cardgenius-2 5/5 · cl_fml-x-abhishek-pal 5/5 · cl_abhishek-pal-fml 5/5 · cl_fml-new 5/5 · cl_the-job-workshop-ad-account 5/5 LIVE** (Meta 200 + fbtrace_id each, `pixelUsed` = the numeric `.env` pixel, `event_source_url` = the `.env` URL); **cl_piyush-ahuja stays SIMULATED** (no pixel key + no URL key — correct, not a bug). 39 live · 5 simulated · 1 skipped · **0 failed**. **EMQ honesty:** the hub-log 200s return NO `event_match_quality` (0 rows with a Meta-reported EMQ) — EMQ≥7 on Purchase stays gated on G3-matched live traffic, not claimed here. | `META_EVENT_SOURCE_URL_*` in `.env` · `POST /api/capi` | **LIVE (6/7 clients) · cl_piyush-ahuja simulated (no pixel + no URL)** | D-12 · 4 new tests (.env-URL verbatim + placeholder-reject, .env-URL→LIVE POST, D-11→LIVE promotion, no-pixel stays simulated) |

### G1 evidence (2026-10-29) — PASS GATE cleared
- `tsc --noEmit` clean · `vitest` **105/105** · `pnpm build` exit 0.
- FX live path: `open.er-api.com` USD→INR **95.29615** fetched 2026-10-29 (real, no key); INR accounts convert 1:1.
- **Real pull** (`pnpm pull:once` on act_4749960348632164 "Upcurvv-FML", INR): **39 spend rows**, real campaign/adset/ad names, INR rate 1.0.
- **3-ad spot-check** (DB vs fresh live `/insights` read): 0.00% Δ on each ad; **account total ₹51,480.77 = live ₹51,480.77 (0.000%)**. PASS GATE "spend within 1%" **cleared**.
- Two seed accounts (`act_1234567890`, `act_2223334445`) 403 — correct isolation (no ads_read grant); the real account pulled clean.
- **Meta gotchas found & encoded** (documented in `pull.ts`): ad-account refs need the `act_` prefix; this account's `time_range` param 400s → use the no-range 30-day rollup; `link_clicks`/`leads` not valid on v23.0 for this account → documented proxies; ad objects (not `adset_creative`) are the spend units.
- `.env` hygiene: `META_AD_ACCOUNT_IDS` had a stray quote (raw ref 404'd); normalized. Token/IDs live in `.env` (gitignored) — values never in chat or commits.

## Public tunnel (dev webhooks + xt.js ingest host)

| Item | Value | Status |
|---|---|---|
| Public URL (CURRENT) | `https://docs-reserve-inside-parking.trycloudflare.com` → `http://localhost:3000` | **LIVE** — re-verified again at the G3 close-out (2026-11-06/07; the recorded G3-prep host was still the running one — no cloudflared rotation this session: `/` 200 + `/xt.js` 200, 5,078 B). Prior subdomains `vegas-legacy-fully-presenting` (2026-11-05), `oak-alpha-rewards-workstation` (2026-10-30) + `naval-look-noble-sampling` (2026-11-04) are **DEAD (HTTP 000)** — quick-tunnel subdomains die with each cloudflared restart; **re-verify before use, never hard-code as permanent**. |
| Tunnel | cloudflared quick tunnel (user-run, no account) | Each restart gives a NEW random subdomain; all hosts in code/docs stay **host-agnostic** (webhook/ingest/xt.js refs use the live URL only as the *current value*). **G10 later swaps this for a stable Vercel domain** — no host is referenced in code, so that swap stays clean |

End-to-end verification through the public URL (2026-10-30):

- **First run** (old subdomain `competitive-gilbert…`): `GET /` → **200**; `GET /api/session` → **200** (real session: owner `arpit@…`); `GET /xt.js` → **200**, 5,071 B served.
- **Current URL** (`oak-alpha-rewards-workstation`, from filled G3_INPUTS.md): `GET /` → **200**; `GET /api/session` → **200**; `GET /xt.js` → **200**, 5,071 B (checked 16:10 IST). Old subdomain returns 000 (tunnel was restarted).
- `POST /api/ingest` (xt.js `ad_click` touchpoint with `ad_id`/`adset_id`/`campaign_id` + UTM) → **accepted**, persisted: a `Touchpoint` with `adId` + `utmSource` set, no lead (anonymous ad click). `events:0` is expected — that counter counts **lead-bearing** events. *(These pre-purge probe rows were removed in D-02; the round-trip itself was the verification.)*
- Meta `hub.challenge` handshake `GET /api/webhooks/meta` → **200, exact challenge echo** with the stored `.env` verify token; **403** on a wrong token (route reachable + gate works through the tunnel).

This URL is the host for **G3** (paste `xt.js` + `API_BASE`) and the inbound base for **G4** payment/gateway webhooks. It is a **temporary** dev endpoint: G10 replaces it with Vercel + a stable domain, and both must be re-pointed then.

## G3 status (updated 2026-10-30 16:50 IST — G3 run: contract fixes + E2E verified)

**G3 contract bugs found & fixed by running the G3 check** (3 bugs in the original build that would have silently broken prod):

1. `xt.js` posted to `/api/webhooks/ingest` (404 — endpoint is `/api/ingest`); body nested `client_id` inside each event, but the route reads top-level `client` → 400. **Fixed** `postBatch`: `POST {api}/api/ingest` with `{ client, platform: "xt", events }`.
2. No CORS anywhere: `join.upcurvv.com` page → tunnel API is cross-origin; a JSON POST needs a preflight that the app never answered. **Fixed** with `src/lib/cors.ts` + `OPTIONS` export + echoed `Origin` on all `/api/ingest` responses (public endpoint, no credentials — `*`-safe).
3. Rebuilt: xt.js 4.96 KB; `pnpm build` clean; **105/105 tests pass**.

**End-to-end through the public tunnel** (`oak-alpha-rewards-workstation`, 2026-10-30):

| Check | Result |
|---|---|
| `OPTIONS /api/ingest` preflight (Origin `join.upcurvv.com`) | **204** + `ACAO: https://join.upcurvv.com`, `Allow-Headers: Content-Type`, `Max-Age: 86400` |
| Exact xt.js `POST /api/ingest` (page_view w/ ad_id + UTM) | **200 accepted**, persisted: `Touchpoint` ad_click with `adId` + `utmSource` set |
| Missing `client` | 400 `client required` (CORS headers still present) |
| Unknown `client` | 404 |

**Param-audit on PO's real template (from filled G3_INPUTS.md): PASSES.** `https://join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}` — the delivered URL's `campaign_id`/`adset_id`/`ad_id` query keys are exactly what xt.js's extractor reads (`xt/src/index.ts` lines 63–65). Every delivered ad click carries an ad_id **by construction** → the "≥95% of landing-page leads carry ad_id or UTM" gate is satisfied by construction; the live-traffic re-measure happens once the snippet below is pasted. Re-runnable: `node scripts/audit-g3-link.mjs "<delivered link>"`.

**data-client resolved (D-01/D-02):** `client` / `pilot clientIds` = `cl_upcurvv`
(the seed clients `cl_fitness`/`cl_iitprep` are gone post-purge; `cl_upcurvv`
is the only client). All 4 G3 sub-values are now real — no `BHARNA` left.

**Paste-ready, PER-CLIENT snippets (G3 prep, 2026-11-06)** — host
`https://docs-reserve-inside-parking.trycloudflare.com` (re-verified
2026-11-06: `/` 200 + `/xt.js` 200, 5,078 bytes byte-identical to
`public/xt.js`). Quick-tunnel subdomains rotate every cloudflared restart
(`vegas-…`/`oak-…`/`naval-…` all dead = 000; re-verify before every
paste — G10 swaps for a stable Vercel domain). Every block below is
byte-identical except `data-client` (and the shared-page note).

| Client | Landing page (PO-supplied) | `data-client` | Paste-ready block |
|---|---|---|---|
| `cl_upcurvv` | `https://join.upcurvv.com/cll` | `cl_upcurvv` | block A |
| `cl_cardgenius-2` | `https://webinar.cardgenius.co.in/wb` | `cl_cardgenius-2` | block B |
| `cl_fml-new` | `https://jcbwebinar.cracckify.com/` | `cl_fml-new` | block C |
| `cl_the-job-workshop-ad-account` | `https://join.thejobworkshop.com/webinar` | `cl_the-job-workshop-ad-account` | block D |
| `cl_abhishek-pal-fml` + `cl_fml-x-abhishek-pal` | **SHARED** `https://join.affluentindianshub.com/vpaxdvju` (PO-confirmed shared) | two clients, ONE page | block E + F (shared-page rule below) |
| `cl_piyush-ahuja` | **no landing page supplied** (PO to add later) | — | honest "no page yet", not a gap |

```html
<!-- A — cl_upcurvv (join.upcurvv.com/cll). CURRENT live host as of 2026-11-06
     = docs-reserve-inside-parking (re-verify: quick-tunnels rotate every restart).
     G10 swaps this for the stable Vercel domain. -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_upcurvv"
        defer></script>
```
```html
<!-- B — cl_cardgenius-2 (webinar.cardgenius.co.in/wb) -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_cardgenius-2"
        defer></script>
```
```html
<!-- C — cl_fml-new (jcbwebinar.cracckify.com) -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_fml-new"
        defer></script>
```
```html
<!-- D — cl_the-job-workshop-ad-account (join.thejobworkshop.com/webinar) -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_the-job-workshop-ad-account"
        defer></script>
```

**Shared-page rule (abhishek): the page `join.affluentindianshub.com/vpaxdvju`
serves BOTH `cl_abhishek-pal-fml` and `cl_fml-x-abhishek-pal`, but one
`<script>` carries only ONE `data-client` — so its snippet must NOT silently
pick one. Two options, PO's call:
(1) split the page / add a URL discriminator the page can key on, then paste
the matching block;
(2) keep one page and add a client hint the page passes (e.g. a
`?client=` or route segment) — the snippet still takes a single `data-client`,
so the hint must resolve to exactly one of the two before the tag is
emitted. Until that's decided, the shared page gets NO block:

```html
<!-- E — ONLY if the page resolves to cl_abhishek-pal-fml -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_abhishek-pal-fml"
        defer></script>
```
```html
<!-- F — ONLY if the page resolves to cl_fml-x-abhishek-pal -->
<script src="https://docs-reserve-inside-parking.trycloudflare.com/xt.js"
        data-api="https://docs-reserve-inside-parking.trycloudflare.com"
        data-client="cl_fml-x-abhishek-pal"
        defer></script>
```

## G3 status (post D-02 remodel, 2026-10-30 — gate now LIVE-traffic-only)

| G3 sub-item | Status | Evidence |
|---|---|---|
| Final `xt.js` build | **DONE** — 4.96 KB (<10 KB), served at `/xt.js` via tunnel; contract fixed (`POST /api/ingest` + top-level `client`), CORS preflight added | `public/xt.js`; commit `6feec32` |
| Host URL | **DONE (rotates)** — current live subdomain `docs-reserve-inside-parking.trycloudflare.com` (re-verified 2026-11-06, HTTP 200: `/` + `/xt.js` 5,078 B); re-verify before every paste — quick-tunnel subdomains die with the process (`vegas-…`/`oak-…`/`naval-…` already 000) | GET `/` + `/xt.js` via tunnel 200 |
| data-client | **RESOLVED** → `cl_upcurvv` (D-01) | `G3_INPUTS.md` |
| Param-audit | **PASSES by construction** — the PO template's `campaign_id`/`adset_id`/`ad_id` query keys are exactly what xt.js's extractor reads (`xt/src/index.ts` L63–65) | `node scripts/audit-g3-link.mjs "<link>"` |
| **≥95% ad_id/UTM gate** | **AWAITING LIVE TRAFFIC** (D-03 · G3 prep → close-out) | Now a **per-client** gate measured by `pnpm g3:measure` across all 7 clients (MET only on ≥20 live clicks, else AWAITING — 0 is a valid state, never MET, never faked). **Pre-click baseline committed at the G3 close-out (2026-11-06/07):** cl_upcurvv = 3/3 carry (all 3 are **legacy seed** `meta_form_lead` rows, `adRefId=null` — not live clicks) → `<20` → **AWAITING**; the other 6 clients = 0 live clicks → **AWAITING**. **EMQ≥7 on Purchase: no Meta-reported `event_match_quality` on any Purchase → AWAITING (not claimed — a hub-log 200 without EMQ is NOT a pass).** Re-run `pnpm g3:measure` after the PO's clicks + a CAPI queue run; the 95% gate + EMQ≥7 become real. **Shared page (carry-forward (b)):** `join.affluentindianshub.com/vpaxdvju` (abhishek + fml-x-abhishek) gets NO snippet until the PO adds a client hint or splits the page (PO decision, recorded in DECISIONS) — not a code-side pick. **cl_piyush-ahuja (carry-forward (c)):** no landing page supplied → out of G3 live-traffic scope (honest, not a gap). |

**Pass evidence required (D-03):** after pasting the snippet, Meta delivers a
real click → a touchpoint must land with `client=cl_upcurvv` + `adId` non-null.
No seed backfill counts.

## Webhooks / integrations (spec §6)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Public tunnel for webhooks/ingest | cloudflared quick tunnel | Live, verified end-to-end 2026-10-30 (see "Public tunnel" above) | Stable base for G3 `xt.js` + G4 gateway webhooks; retired at G10 | **LIVE (temporary)** | Public tunnel block |
| xt.js on landing pages (G3 prep → close-out) | `xt/` → `public/xt.js` (5,078 B) | Built + served at `/xt.js` via the close-out re-verified tunnel `docs-reserve-inside-parking` (2026-11-06/07, `/`+`/xt.js` 200, 5,078 B byte-identical to `public/xt.js`); **not deployed to any live page yet**. **PASTE-READY PER-CLIENT snippets for all 7** (above table) — 5 solo pages + 1 shared page (`affluentindianshub.com/vpaxdvju` = abhishek + fml-x-abhishek; **close-out: no snippet until the PO adds a client hint or splits the page — PO decision recorded, no silent single-client pick**) + `cl_piyush-ahuja` "no landing page supplied" (out of G3 live-traffic scope). Measurement via `pnpm g3:measure` (per-client ad_id/UTM carry + EMQ≥7 status). | PO pastes each snippet + drives ~20 real Meta ad clicks + re-runs `pnpm g3:measure` (the 95% gate + EMQ≥7 become real — D-03: measured on LIVE traffic only; a hub-log 200 without a Meta-reported EMQ is NOT a pass) | **CLOSED-OUT: READY → PRE-CLICK AWAITING LIVE TRAFFIC (baseline 2026-11-06/07: 0 live clicks, 95% + EMQ≥7 unmet-by-absence, never faked)** | G3 close-out · 2026-11-06/07 · `pnpm g3:measure` |
| Meta dynamic URL params (G3 prep → close-out) | `scripts/audit-ad-urls.mjs` (read-only) + `scripts/audit-g3-link.mjs` (PO link template) | **G3 close-out 2026-11-06/07, re-run across ALL 7 stored AdAccount rows:** 5 accounts **UNAUDITABLE** (ad rows readable, 0 readable destination links — G1 token lacks creative-content read; a read-only fields probe confirms even account-level `adcreatives` returns `link=null` + empty `object_story_spec` for this token; the ads-level `creative{link}` spelling is a `#100` invalid field) · cl_fml-x-abhishek-pal = **transient rate-limited in this run** (0 read; the G3-prep full run read its 1,572 ads, also 0 links) · cl_upcurvv = **PO-coverage** — the PO's own declared template in `G3_INPUTS.md` (`join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`) passes `node scripts/audit-g3-link.mjs` by construction, recorded as evidence. **Resolution is the PO's call (not picked silently): Option 1** — PO reads each account's ad destination URLs in Ads Manager and reports which lack template/UTM params (the Meta-side fix is PO-manual; we RECORD the ad ids to change). **Option 2** — PO grants a token with creative-content (`ads_read` + link) read; re-running `node scripts/audit-ad-urls.mjs` then yields a real PASS / N-ads-to-fix table per account. Until such evidence lands, the gate verdict stays **UNAUDITABLE (not a PASS, not a fake "no URLs")**. | `{{campaign.id}}/{{adset.id}}/{{ad.id}}` (or UTM) on every ad URL | **AUDITED → UNAUDITABLE on the G1 token (5 accounts confirmed; 1 rate-limited; upcurvv PO-covered by its declared template); RESOLUTION PENDING PO: Ads-Manager URL report (Option 1) OR upgraded creative-read token (Option 2)** | G3 close-out · `node scripts/audit-ad-urls.mjs` + `node scripts/audit-g3-link.mjs` (read-only) |
| **G4 per-client routing (Razorpay / Cashfree / Cosmofeed / TagMango / FlexiFunnels)** | `api/webhooks/[platform]` + `adapters/payments.ts` + `ingest.ts` | **APP-SIDE DONE 2026-11-03 (D-06):** `POST /api/webhooks/<platform>?client=<id>` reconciled across all **7 clients × 5 G4 platforms = 35/35 accepted** via a locally-replayed, correctly-signed provider event (`scripts/g4-replay.ts`); each platform's `verify` ran against a **per-client `Client.webhookSecret`** (provisioned for all 7; real, not the seed `whsec_*` fakes). Bad signature 502s (rejects), not a fake accept. Fixed a real latent bug the replay exposed: `OutboundEvent.eventId` was the lossy `dedupKey.slice(0,64)` → two CAPI events for one lead across gateways collided on the `@unique` column and 502'd 12/35; now stores the full already-unique `dedupKey` (regression test in `ingest.test.ts`). Dashboard leads-family KPIs flip 0→live on a full-funnel replay. **REAL-PROVIDER HOP still BLOCKED:** no RAZORPAY/CASHFREE/COSMOFEED/TAGMANGO/FLEXIFUNNELS gateway API key in `.env` (only the Meta token + verify token + FX + ingest shared secret exist) — so live gateway traffic isn't exercisable yet; per-client `webhookSecret` is set, ready to point a real gateway at. | Point the 5 real gateways at `POST /api/webhooks/<platform>?client=<id>` on the G10 host; per-client `webhookSecret` already on each Client row | **DONE (app-side) · BLOCKED(real-provider): needs 5 gateway API keys in `.env`** | D-06 · `scripts/g4-replay.ts` (35/35, 7/7 handshake) · 127/127 tests |
| Aevent / Zoom | `adapters/engagements.ts` | Implemented | Real webhooks + test attendee (register/attend/replay) | **BLOCKED: needs platform configs + test attendee** | G5 |
| Calendly / Pabbly / WhatsApp | `adapters/engagements.ts` | Implemented | Real webhooks + real booking + WhatsApp round-trip | **BLOCKED: needs accounts + test actions** | G6 |
| Sheets/CSV backfill | `api/import` + `src/lib/csv.ts` | Implemented (dry-run preview not yet built) | Real old-client sheet import with mapping + commit-after-approve | **BLOCKED: needs a real sheet** | G7 |

## Reconciliation & reporting (spec §7)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Revenue vs gateways ≤2% | `reports.ts` | No payments yet (0 rows post-D-02; first real sale lands with G4) | Pilot-week reconciliation vs gateway dashboards | **BLOCKED: needs G4 live** | G9 |
| Spend vs Ads Manager ≤1% | `reports.ts` | G1 live pull now populates real spend (39 rows, ₹51,480.77, re-parented to `cl_upcurvv` in D-01); account total vs live = 0.00% | Full pilot-week reconciliation vs Ads Manager dashboards | **LIVE (single-account)** — 3-ad + account-total check cleared 0.00%; G9 pilot-week table still pending | G1 cleared the gate for this account; G9 formalizes across a week |
| Meta vs Track conversions | `reports.ts` | G1-pulled `metaConversions` (real pull values; 0 counted yet — no live traffic) | Real Meta-reported vs our counted | **AWAITING G3 live traffic (never fake)** — G8 CAPI send is now LIVE, but the counted side is 0 until G3 drives real browser-pixel/Pixel-matched Purchase traffic; the report stays an honest "no live data" until then, not a fabricated match | G9 |
| Weekly Monday 9AM IST summary | `reports.weeklySummary()` (served at `GET /api/reports?key=weekly`) | `weeklySummary()` composes all report sections + is CSV-exportable (unit-tested, wired in the reports route); **no durable Monday-09:00-IST scheduler, no PDF yet** — the add-on is recorded here as a stub; durable cron → portal + PDF is deferred to G9/G11 | Durable cron → portal + PDF | **STUB (function live + wired; scheduler & PDF = G9/G11)** | G9/G11 |
| CSV/Excel export | `reports.ts` | Working | — | LIVE (code-complete, unit-tested) | G0 commit |

> **G2-deferred consequence (PO decision 2026-10-30, recorded on G9 too):**
> "Lead source mix" will show **Instant Form = 0%** — expected, not a bug.
> CAPI **Lead** events come from `form_submit` (xt.js) and CSV imports, not
> `meta_form_lead`. G2's gate ("100% of Instant Form leads land <1 min with
> ad_id") is **dropped** from the G9 checklist; G8 dedup rules unchanged.

## Platform / security (spec §8, §10)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Auth | `src/lib/session.ts` | `DEMO_USER` env + `xacqora_user` cookie; users = the two Foremost staff (owner + admin, D-02) | Supabase/Clerk Auth + 2FA on all FL users | **MOCK** | G10/G11 |
| RLS | Postgres (not SQLite) | Query-layer `clientId` scoping only | DB-level RLS policies + negative test | **MOCK (no DB support yet)** | G10 |
| Hosting | Next.js local (`next start`) | Local dev server | Vercel + Mumbai Postgres; tunnel retired | **MOCK** | G10 |
| Backups / restore test | — | None | Daily backup + monthly real restore | **MOCK** | G10 |
| Error tracking (Sentry) | — | Not wired | DSN + webhooks alerted on failure | **MOCK** | G10 |
| Secrets at rest | `.env` | Plaintext env, gitignored | Encrypted store (Supabase secrets / KMS) | **MOCK** | G10 |
| Audit log | `security.ts` + `audit` screen | Working, seed rows | Live actions | LIVE (code-complete) | G0 commit |
| Phone/email hashing (SHA-256) | `src/lib/hash.ts` | Working, unit-tested | — | LIVE (code-complete) | G0 commit |
| Ingest rate limit | `security.ts` | Working (in-memory) | Redis-backed for multi-node | LIVE (code-complete) | G0 commit |
| Webhook signature verify | `adapters/*` + `ingest.ts` | Razorpay/Cashfree HMAC + shared-secret verify; unit-tested; **per-client `Client.webhookSecret` provisioned for all 7 (G4/D-06)** | Real gateway keys (in `.env`) | LIVE (code-complete + app-side G4 verified; 5 real gateway API keys still pending) | D-06 (was G0) |

Legend: **LIVE** = real-data verified · **MOCK** = code-complete but running on
seed/simulate/fake · **BLOCKED: needs X** = code exists, live path waits on X.
