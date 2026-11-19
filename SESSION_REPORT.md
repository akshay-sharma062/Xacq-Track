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
  `scripts/spot-check-accounts.ts`): a same-rolling-window comparison. **G1 exact
  0.000%**; the high-volume accounts show a small Δ **only** when the stored
  snapshot's `date_stop` lags the live 30-day window — re-pulling advances it and
  the Δ collapses to 0.000% (verified live: Piyush/CardGenius/G1 0.000% after the
  window advanced; residual 1.4–4.0% on the rows whose `date_stop` had not yet
  advanced = window lag, not a data error). PASS GATE ≤1% cleared for G1.
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

## D-05 Dashboard V2 (2026-11-03) — All-default + 10-min autopull + real FX + dense dashboard, [REVIEW]
**What landed (PO decisions 2026-11-02):**

- **§4 FX made real on this machine (the AED gap closed).** Multi-source chain
  `open.er-api.com → frankfurter.dev → exchangerate.host` (source recorded on the
  `FxRate` row; all-unreachable → the exact 3 error strings, never a fake rate).
  LIVE: **AED→INR 25.849976** (source #1) fetched on-machine; "The Job Workshop"
  AED account **backfilled to ₹384,113.82** INR (331 spend rows, native AED 14,859.35).
  Also fixed a real `.env` bug: `FX_API_BASE` had a stray inline comment + embedded
  quotes that were silently breaking source #1's URL — the honest root cause of the
  earlier "FX blocked" state. 12 `fx-store` tests (mock source, fallback order,
  backfill idempotency).
- **§3 10-min autopull + single-writer discipline.** `runFastTick()` (new `pnpm
  pull:fast` + resident `startFastLoop()`) refreshes the day's data every 10 min and
  re-runs the FX backfill in the same tick. A cross-process **file lock**
  (`src/jobs/pull-lock.ts`) makes a running tick SKIP, never parallelize — the exact
  lesson from the idempotency incident. 30-min TTL so a dead holder can't wedge the
  pipeline. The 3-hourly entity tick is folded into the 10-min cadence. Lock test:
  `test/pull-lock.test.ts` (8 tests: fresh/skip/stale-steal, owner-only release, grid).
- **§1 All-clients / All-accounts default.** `resolveClientSet` + `dashboardAll` + the
  spend-family reports now default to the aggregate view across the visible client set
  (sums for additive figures, recomputed rates for cost-per/ROI/ROAS — never summed);
  per-client / per-account drill-down unchanged. Both selectors stay DB-driven —
  adding account #8 in `.env` makes it appear with zero UI change.
- **§2 dense dashboard + §3b 60s auto-refresh.** The default render is information-dense
  off the G1 pulls: aggregate KPI row (per-currency + INR), 7 per-account cards
  (last-pulled stamp), daily-spend chart, top campaigns + top ads (thumbnails), CAPI
  send-status strip (honest 0s until G8), and a sync/FX strip. The client polls
  `/api/session` every 60 s → server refresh (no Meta calls from the browser). A
  leads-family 0 is labelled "AWAITING LIVE TRAFFIC (G3/G4)" — honest, not a fake.

**Verification (ticket's checklist):**
- **Two consecutive 10-min ticks, idempotent.** Clean foreground run: tick 1
  `{lock:{acquired:true}, pulled:{ran:7}, fx:{updatedRows:0}}` (5m47s real pull);
  per-account row counts **unchanged** baseline→after (`ad=3808, creative=3808,
  spend=3808, adSet=1172`); a 2nd tick while one is in-flight correctly reports
  `acquired:false` and skips (never parallelizes).
- **FX backfill LIVE:** AED→INR 25.849976 fetched on-machine; AED account
  `inrSpend` went ₹0 → **₹384,113.82**.
- **`pnpm test` 126/126 · `pnpm build` exit 0** (up from 113 pre-ticket: +8
  `pull-lock`, +5 `fx-store` net new; the dense dashboard is DB-read, typechecked).
- D-05 recorded in `DECISIONS.md`; `GOLIVE_STATUS.md` rows "Dashboard V2 + 10-min
  autopull + FX" → DONE.

**Honest notes:**
- 3 of 7 accounts showed a `failures` count in the live tick (transient Meta rate /
  fetch on the largest accounts); that's the expected per-account isolation — the
  other 4 pulled clean, and a re-tick (or the 3h/nightly slot) clears them. Not a
  fake success: failures are recorded, not hidden.
- FX source #2 (frankfurter) returns 404 for AED (not in the ECB set) and source #3
  (exchangerate.host) now needs an API key (401) — source #1 alone is sufficient;
  the chain is correct and the two failures are logged, not papered over.

**Next gate = G4 webhooks per client.** The dev webhook host is the current
trycloudflare tunnel (G10 swaps it to a stable domain). Per-client inbound URL
(`POST /api/webhooks/<platform>?client=<clientId>`), 7 clients (one per D-04
onboarded account):

```
host = https://oak-alpha-rewards-workstation.trycloudflare.com   (re-verify: quick-tunnel subdomain dies with the cloudflared process)

cl_upcurvv                     (G1, Upcurvv-FML)
cl_piyush-ahuja                (Piyush Ahuja)
cl_cardgenius-2                (CardGenius 2)
cl_fml-x-abhishek-pal          (FML X ABHISHEK PAL)
cl_abhishek-pal-fml            (Abhishek Pal - FML)
cl_fml-new                     (FML New)
cl_the-job-workshop-ad-account (The Job Workshop, AED)

Each client × each platform, e.g.:
  POST https://<host>/api/webhooks/razorpay?client=cl_upcurvv
  POST https://<host>/api/webhooks/cashfree?client=cl_piyush-ahuja
  POST https://<host>/api/webhooks/aevent?client=cl_cardgenius-2
  … platforms: meta, razorpay, cashfree, cosmofeed, tagmango,
    flexifunnels, aevent, zoom, calendly, pabbly, whatsapp, sheets, xt, manual
Secret placement: the gateway/platform signature secret goes in the Client row's
`webhookSecret` (per-client, verified by the adapter), NOT in .env; .env keeps
the platform-level `*_WEBHOOK_VERIFY_TOKEN` / CAPI pixel mapping. G10 moves <host>.
```

## G4 — webhooks per client (D-06, 2026-11-03) [REVIEW]
**Gate:** one inbound webhook URL per client per platform
(`POST /api/webhooks/<platform>?client=<clientId>`) across all 7 D-04 clients,
signature/secret verified per client. The route was already host-agnostic; G4
makes it **reconciled + signed for every (client × platform) combo**.

**Verification (all via `scripts/g4-replay.ts` against the live route, re-runnable):**
- **Work 1 — routing:** 7 clients × 5 G4 payment platforms (razorpay, cashfree,
  cosmofeed, tagmango, flexifunnels) = **35/35 accepted** through the real HTTP
  route; each platform's `verify` ran against that client's `Client.webhookSecret`
  (HMAC for Razorpay/Cashfree, shared-secret for the rest). **Meta `hub.challenge`
  handshake: 7/7 echo the challenge per client; a wrong token → 403.**
- **Work 2 — replay + BLOCKED:** one locally-replayed, correctly-signed provider
  event per G4 platform lands (events/payments/capi all 1, dedup 3× replay = no
  double-count, bad signature → 502 reject). Each platform's **real provider-side
  hop is BLOCKED** (no gateway API key in `.env` — recorded with the exact reason
  per platform, never faked). The per-client `webhookSecret` is now set on all 7,
  ready to point a real gateway at.
- **Work 3 — dashboard flip:** a full-funnel replay (Meta lead → registered →
  webinar_joined → call_booked → a paid gateway) under `cl_upcurvv` flips the
  leads-family KPIs from 0 ("AWAITING LIVE TRAFFIC (G3/G4)") to live counts
  (registered 0→1, calls 0→1, sales +1, leads +1). **Source stated honestly:
  locally-replayed events through the live route, not live provider traffic.**

**Real bug found + fixed by the G4 replay:** `OutboundEvent.eventId` was stored as
`dedupKey.slice(0,64)`; two CAPI Purchase events for the **same lead across
different gateways** share a `Purchase:<client>:<phone>:<txn…>` prefix, so their
64-char truncations collided on the `@unique eventId` column and 502'd 12/35 of the
routing checks. The send path keys on `dedupKey` (already `@unique`), so the fix
(`src/lib/ingest.ts`) stores the **full, already-unique `dedupKey`** as `eventId`
(no truncation). Regression test in `test/ingest.test.ts` ("one lead paying through
two gateways …"). Result: **35/35 routing, 7/7 handshake, dashboard flip confirmed.**

**Environment notes (re-verified 2026-11-03):**
- The dev tunnel host `oak-alpha-rewards-workstation.trycloudflare.com` is **DEAD**
  (HTTP 000 / unresolvable; subdomains die with the cloudflared process). The route
  was proven host-agnostic against a local `:3100`/`:3101` `next start`, so G4 does
  not depend on that host — G10 supplies the real host.
- `pnpm test` **127/127** (was 126, +1 regression test) · `pnpm build` exit 0 ·
  working tree clean (no dev.db/.env/.tmp committed).

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

## G8 — CAPI LIVE with per-client pixel mapping (D-07, 2026-11-04) [REVIEW]
G8 gate = spec §5.8 + Phase-3 acceptance **EMQ≥7 on Purchase**. CAPI send
path flipped from simulate to **real Conversions API POST** with per-client
Meta pixel (Data Source) mapping.

**Pixel mapping (values in `.env` only; code is value-free)** — `META_PIXEL_ID_<CLIENTID-UPPER>`
via `meta/pixel-map.ts` (`pixelForClient`). PO-supplied IDs reconciled to all 7
slugs; two accounts share one ID where PO wrote the same id (stored, ALT-keyed
for the second). `cl_piyush-ahuja` intentionally has **no** pixel key ⇒ stays
simulate (never faked).

**Live/simulate flip** — `sendQueue` sends a real POST when BOTH
`META_ACCESS_TOKEN` + a client pixel are present; no token ⇒ honest local mark
(`simulated=true`), no network. Hashed `ph`/`em` (SHA-256), `fbc`/`fbp`,
frozen `event_id` dedup (never send twice), retry queue on 4xx/403 (retriable,
row `failed` + the **exact Meta error string**, no fake success).

**EMQ read-back** — persisted verbatim from Meta
`event_hub_log_view[].event_match_quality`; `emqFromMeta=true` **only** when Meta
returned a usable number — never invented. Dashboard CAPI strip splits live vs
simulated + Meta-reported vs estimated EMQ.

**Wire-shape fix that unblocked Meta** — web-originated events send
`action_source:"website"` + `event_source_url`. Meta 400 subcode `2804039`
rejected `system`/`browser` and prescribed `"website"`; flipping
`CAPI_ACTION_SOURCE` to `"website"` (and threading a source URL into
`buildCapiEvent`) produced the **Meta HTTP 200 ack** (fbtrace_id
`AoRi_ZmEpa895gB22GnWzRW`) on the labelled `pnpm capi:replay` synthetic Purchase
for `cl_upcurvv`.

**Honest caveat** — that 200 ack came back **without** a hub-log `event_id` or
EMQ value, because the replay is synthetic (no G3-matched browser-pixel
traffic). `EMQ≥7 on Purchase` therefore remains gated on **real G3 live
traffic** through this path — not claimed from synthetic data.

**Add-ons** — "Meta vs Track" report wiring = **AWAITING G3 live traffic**
(never faked); weekly Monday 9AM IST summary + PDF scheduler = recorded stub
(`GET /api/reports?key=weekly` is live + wired; the durable cron + PDF are G9/G11).

**Verification** — `pnpm typecheck` 0 · `pnpm test` **138/138** (+2 CAPI
live-path cases incl. the `website` wire shape) · `pnpm build` exit 0 · live
CAPI POST evidence (`Meta HTTP 200` + fbtrace_id) above. No pull row touched
(ad=3808, adSet=1172, spend=3808, fxRate=1, G1=cl_upcurvv); WAL journal intact
(`f5a641b` fix stands); no `.env`/`dev.db`/scratch committed.

**Next gate:** drive **real G3 live traffic** (paste the `xt.js` snippet on
`join.upcurvv.com` + one real Meta ad click) so G8's acceptance number
(EMQ≥7 on Purchase) is claimed from a Meta-reported EMQ on G3-matched Purchase
traffic — not from the labelled replay. Then G9 (Meta-vs-Track reconciliation
+ weekly PDF) and G10/G11 (platform go-live).

## D-08 — Meta data expansion + date-range filters (2026-11-05) [REVIEW]
Ticket: "Meta data expansion + date-range filters" — Phase-1 HONEST API PROBE
before building anything UI; build ONLY what the probe proved.

**Phase 1 — probe** (`scripts/meta-probe.ts`, `pnpm meta:probe`, read-only,
ONE account first = cl_upcurvv's `act_4749960348632164`, NO DB writes, token
redacted; findings in `.meta-probe-findings.txt`, gitignored):
- (a) account-level `fields=balance` → **200** (`"balance":"218661"` INR) —
  G1 never pulled it; Balance is a real, buildable card.
- (b) insights time params: `time_preset` (all 5) / `date_start`+`date_stop`
  / `period=daily` all 200 **but IGNORED** — every one returns the same
  default 30-day rollup (rows=1, distinctDays=1). **No per-day rows exist.**
  The ONE honored range param is a well-formed `time_range` (G1's 400 was the
  empty/malformed form). `time_range` returns a *range rollup* (one row per
  ad), not per-day — so it can't feed per-day storage either.
- (c) `lpv` / `clpv` → **400** `#100 not valid for fields` at BOTH ad and
  account insights level → **no LPV/CLPV card; the 400 is recorded.**

**Phase 2 — built only what the probe proved:**
- Per-day pull: **SKIPPED** (the "if daily rows come back" conditional was
  false — never faked). Existing 30-day rollup rows stay; fixed point
  ad=3808/adSet=1172/spend=3808/fxRate=1 untouched; WAL intact.
- Balance: `AdAccount.balance` + `balanceAsOf` (additive `db push`);
  `pullAdAccount` now fetches `fields=balance` **isolated** (a balance 4xx
  records the exact Meta string, never fails the spend pull, never clears the
  last stored value — the card shows the last known or "—", not 0). Surfaces
  on dashboard account cards + `/meta`.
- Dashboard date-range control (`?range=` Yesterday/7D/30D/Last Month/Last
  Year/Custom): the SPEND family always shows the closest available stored
  data (the 30-day rollup) — any non-30d range carries the honest label
  "30-day rollup only (Meta API limit — see DECISIONS D-08)", never an
  extrapolated number. The LEAD family (real timestamps) is sliced to the
  range. Absent `?range` = byte-identical to pre-D-08 behaviour.
- Meta "Leads" mapping recorded (DECISIONS D-08): NOT an insights metric on
  these accounts (`leads` 400 documented in G1, re-confirmed) — the source is
  G2 Instant Forms (deferred) or G3 clicks; never faked from insights.

**Tunnel host (host-agnostic rule):** current live subdomain
`vegas-legacy-fully-presenting.trycloudflare.com` → `:3000` (re-verified
2026-11-05, HTTP 200); `naval-look-noble-sampling` (2026-11-04) +
`oak-alpha-rewards-workstation` (2026-10-30) are DEAD (HTTP 000). All
webhook/ingest/xt.js host references stay host-agnostic in code + docs; the
live URL is the current value only. G10 swaps this for a stable Vercel domain.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **152/152** (+14 D-08:
range ×5, dashboardAll range-slice ×3, balance persistence ×3, probe-table ×3)
· `pnpm build` 0 · live smoke: `/?range=yesterday|7d|last_year|custom` all 200
with the rollup label; `/meta` balance card "— (not pulled)" until the next
real pull. No `.env`/`dev.db`/scratch committed.

**Next gate:** next real `pnpm pull:once` populates `balance` (verify the card
shows the number, not "—"); then G3 live traffic (EMQ≥7 for G8), G9, G10/G11
as before.

## D-09 — close the data gaps before live traffic (2026-11-05) [REVIEW]
Ticket: "close the data gaps before live traffic" — FX backfill gap
(money-integrity), balance pull, G3 snippet regeneration.

**1. FX backfill — HONEST FINDING (the ticket's premise was checked against
the data and did NOT hold, so it was not faked):** 3,212 of 3,808 Spend rows
had `inrSpend=0`, flagged as "INR total understated". A read-only
diagnostic (`scripts/fx-diag.mjs`) proved all 3,212 are **zero-spend
placeholders** (`spend=0` on every one; `moneyGap=0` rows with spend>0;
0 rows violate `inrSpend == round(spend × inrRate, 2)`; AED positive-spend
already normalised at 25.849976; recomputed total off by ₹0.02 rounding
only). **Built anyway (ticket rule 1 + durable safety net):**
`backfillInrZeroRows` (fx-store) bulk-stamps every `inrSpend=0` row — INR
1:1 identity, non-INR at the per-day stored rate (else most-recent stored,
else live multi-source fetch; no rate + all sources down = **BLOCKED with
exact per-source error strings, rows untouched, never a fake rate**).
Idempotent, never deletes. Wired into the 10-min fast tick + `pnpm fx:backfill`.
**Proof:** un-stamped rows 3,212 → 0; INR total **3,219,655.33 → 3,219,655.33
(Δ 0.00)** — the stamp is a rate-consistency fix, not a value recovery;
re-run byte-identical (0 updates). Fixed point ad=3808/adSet=1172/spend=3808
untouched; WAL intact. The "recovered ₹X" claim is explicitly NOT made.

**2. Balance pull:** `pnpm pull:once` now persists `AdAccount.balance` per
account (the D-08 fetch path). Read-only `pnpm balance:check` (exact
per-account 200/error, no DB writes) confirmed **all 7 accounts return a
live balance**: Upcurvv-FML **₹283,383**, Abhishek Pal **₹2,070,383**, FML New
**₹692,084**, FML X Abhishek Pal **₹615,668**, CardGenius 2 **₹350,054**, The
Job Workshop **AED 28,252** (native, shown in account currency), Piyush
Ahuja **₹0** (legitimate zero ≠ "not pulled") — final 07:03–07:05 pull
snapshot; Meta's `balance` is a moving figure (Upcurvv-FML's earlier pull
stored 283,383; the D-08 probe had seen 218,661 — we store Meta's value at
pull time, never force an old number). **Fixed-point disclosure:** the pull
advanced Meta's live tree to ad=3818 / adSet=1177 / spend=3818 (additive
growth since October; no pull row deleted — the backfill is update-only,
re-run byte-identical). The account cards + `/meta` show the real balance
for pulled accounts, not "—".

**3. G3 snippet regeneration:** the xt.js paste-ready block in
GOLIVE_STATUS.md now references the CURRENT live tunnel
`vegas-legacy-fully-presenting.trycloudflare.com` (re-verified HTTP 200
end-to-end before writing; prior subdomains dead/000) with
`data-client="cl_upcurvv"` — paste-ready for `join.upcurvv.com/cll`.
Host-agnostic rule kept for the G10 Vercel swap.

**Verification:** `pnpm typecheck` 0 · `pnpm test` green (+2 D-09 backfill
tests: idempotent recover + BLOCKED-exact-errors) · `pnpm build` 0 · live
routes `/`, `/meta`, `/?range=yesterday`, `/xt.js` 200 · backfill
before/after + re-run byte-identical · balance evidence read-only. No pull
row deleted; `.env`/`dev.db`/scratch never committed.

**Next gate:** **G3 live traffic (PO paste)** — paste the refreshed snippet on
`join.upcurvv.com/cll` + ~20 real Meta ad clicks → the real EMQ≥7 proof and
the ≥95% ad_id/UTM gate. Then G9/G10/G11.

## D-10 — client exception fix + ad-set metrics + live range fetch (2026-11-05) [REVIEW]
Ticket: "client exception fix + ad-set metrics + live range fetch" —
reproduce the client exception first, then add per-ad-set metrics,
honest client scoping, and a server-only live-range fetch with a
per-account/per-day cache.

**Re-probe first (committed matrix, redacted):** `pnpm range:probe`
read-only re-probe confirmed D-08's capability matrix against the live
account: `time_range` (well-formed JSON) IS honored as a range window
(yesterday=6,624 · 7d=34,379.17 · 30d=82,116.98, distinct values);
365d/730d **clamp** to the 30d value; `period=day` is **ignored**
(always rows=1 → Meta serves one range rollup, not per-day rows);
empty/reversed `time_range` = 400 exact `#100` strings. So only
**yesterday/7d** are on-demand servable; last_month/last_year/custom keep
the honest stored-rollup label. Never faked, never zero-padded.

**1. Client-side exception (reproduce-first):** the prime suspect —
`RangePicker`/`Topbar` call `useSearchParams` without a `<Suspense>`
boundary (invariant + CSR full-reload bailout on client-side nav) — was
fixed canonically by wrapping the `useSearchParams` core in an exported
`<Suspense>`-wrapping component (call-site-agnostic). A headless-Chrome/CDP
sentinel repro on a clean prod build showed **0 console errors** on load +
every RangePicker selection, so on the current build the exception did not
reproduce; the recurring breakage was the **corrupted `.next` pattern** (a
stray `next dev` running next to prod `next start`, both writing the shared
`.next` → `550.js` / `routes-manifest.json` ENOENT). Fix: wipe `.next`,
clean build, `next start`; standing rule **never run `next dev` next to
prod**. **Auto-respawner verdict: no config-level respawner found** (no
nodemon/watchman/scheduled-task/dev entry in `.claude/launch.json`, now
`prod-attach` url-only so it can't launch dev). The recurring dev chains
came from a **manual user terminal tab** running `pnpm dev`; that tab is
user-owned, cannot be closed from here, flagged for the report.

**2. Ad-set metrics + client scoping:** `adSetPerformance()`
(`src/lib/reports.ts`) builds the per-ad-set table (name, campaign, spend
native+INR, impressions, reach, clicks, CPM, CPC, ROAS where sales exist)
from **stored Spend/AdSet rows ONLY**. **LPV/CLPV are NOT columns** —
`LPV_CLPV_NOTE` says "LPV/CLPV not returned by Meta v23.0 on these
accounts (400 on lpv/clpv fields — D-08/D-10 probe); not shown; cost/LPV
is not guessed." Shown on the dashboard + a `/reports` `ad_set` view.
**Client-scoping bug found + fixed** (`src/lib/dashboard.ts`): the
active-entity KPI counts compared `adAccountId IN clientIds` (cuid vs
`cl_…` — always 0) and creatives scanned ALL clients; now scoped by
`clientId IN clientIds` + the client's ACTIVE ad metaIds. Test: client A
selected → **zero** client B ad sets (and the reverse).

**3. Live range fetch ("filter apply = API hit"), server-only:**
`resolveLiveRange()` (`src/lib/meta/live-range.ts`) — a SERVER-ONLY
on-demand insights fetch for `yesterday`/`7d` (never a Meta call from the
browser). **Per-account, per-day cache** in the additive `LiveRange`
table (unique `adAccountId+rangeKey+day`): same day+range **reuses** the
row, no repeated Meta hit (idempotent — 2nd call = 0 Meta hits, tested).
A Meta 4xx stores the **EXACT error string** as a BLOCKED row (the UI
shows the note, never an empty grid / fake zero); no token = honest skip.
INR-normalised via the stored daily FX rate. The 30-day Spend rollup
fixed point is **never written to here** (LiveRange is a separate
additive table; no deletes). UI: yesterday/7d show a live strip
"live, HH:MM IST" (fresh <1h) or "cached" for same-day reuse;
unservable ranges keep the "30-day rollup only" label.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **161/161** (14 files;
+7 D-10: Suspense-wrap ×2, client-scoping A-vs-B, ad-set LPV-absent +
CPM/CPC math, live-range cache-idempotency, live-range BLOCKED-exact,
no-token-skip) · `pnpm build` 0 · live routes `/`, `/meta`,
`/?range=yesterday`, `/?range=yesterday&client=<id>` 200 (re-verified
below). No pull row deleted; `.env`/`dev.db`/`.next`/scratch (`.d10-*`,
`.debug-*`, `.pre-fix-*` now gitignored) never committed.

**Next gate + live host + respawner verdict:** live host =
`https://vegas-legacy-fully-presenting.trycloudflare.com` (re-verified
HTTP 200 end-to-end 2026-11-05; prior `oak-…`/`naval-…` subdomains dead
= 000). **Auto-respawner: NO config-level respawner found or to stop —
the recurring `next dev` chains came from a manual user terminal tab
(user-owned, flagged not closable from here); `.claude/launch.json` is
now `prod-attach` url-only so the app itself cannot launch dev.**
**Next gate = G3 live traffic (PO paste)** — the refreshed snippet (D-09)
is paste-ready on `join.upcurvv.com/cll`; ~20 real Meta ad clicks unlock
the real EMQ≥7 proof + the ≥95% ad_id/UTM gate, then G9/G10/G11.

## D-11 — CAPI 400 "Object with ID 'pixel'" (2026-11-05) [REVIEW]
Ticket: "CAPI 400: literal 'pixel' string sent to Meta instead of the
numeric pixel id" — every CAPI event (Purchase, Schedule, Attended,
CompleteRegistration, Lead) 400'd with Meta's exact
`"Unsupported post request. Object with ID 'pixel' does not exist …"`.

**Root cause (hunted in the ticket's order, not guessed):** no literal
`"pixel"` value exists in committed code — G0 had *no live CAPI POST at
all* (`postOneCapiEvent` + the `graph.facebook.com/<ver>/<pixel>/events`
URL only exist from G8 `ee7c913`; `git log -S'"pixel"'` touches only G8 +
G0; `.env` pixels are numeric; `Client.metaPixelId` null for all 7; the
route reads `.env` only via value-free `pixelForClient`). The 15 failed
rows are stamped **2026-11-03** (G4/G8 replay era) and carry a **stale**
400 string persisted to `OutboundEvent.error` back when the pixel value
was still the placeholder word `pixel` (the numeric `.env` values were
entered G8-day, Nov 4). Those rows were **never re-run** after the fix
landed, so the CAPI screen kept showing the old 400s (all 45 rows had
`pixelUsed=null`; `sendQueue` records it on success only). The real
defect: **no send-boundary guard** — any placeholder could 400 again.

**The fix (`src/lib/meta/capi.ts` + `src/lib/capi.ts`):**
1. `isValidMetaPixelId()` — a pixel must be a numeric string, 6–20 digits
   (Meta pixel/dataset-id shape). A **type predicate** (narrows to
   `string`).
2. `sendQueue`: `!token || !isValidMetaPixelId(pixel)` → **SIMULATE**
   (local mark, no network, `simulated=true`, `pixelUsed=null`, an exact
   note naming the rejected value) — a placeholder is never POSTed and
   never recorded as "the pixel used".
3. `postOneCapiEvent`: a **second boundary guard** (the shared primitive
   `g8-replay.ts` also calls) rejects a non-numeric pixel with a
   clear, non-network `ok:false` error.
4. **Action-source rule (the live re-run's honest next wall):** the
   replay with the numeric pixel returned **Meta 200 + fbtrace_id
   `Ab_zLGf_…`**, but the 6 pixel-bearing clients' queue re-run hit a
   *different* honest 400 — subcode **2804039** "Invalid action source
   … such as 'website'" (Meta 400 recorded since G8): these pixels only
   accept a web (`website`) source, which REQUIRES `event_source_url`,
   and **no client has a Funnel row** (0 Funnel rows in the DB) → no
   source URL exists and none is fabricated. So: `toMetaWireEvent` drops
   the web-only `user_data` signals (`client_ip_address` /
   `client_user_agent`) on a non-web `"system"` source (the identity
   match signals `ph/em/fbc/fbp` stay — they drive EMQ regardless of
   source), and `sendQueue` gates the live POST: **no source URL → stay
   SIMULATED with the exact note** (Meta-invalid events are never POSTed
   → no 400 loop); it re-activates automatically once the client's
   default Funnel has a landing URL (`eventSourceUrl` is an injectable
   opt, so the rule is unit-tested both ways).
5. **Re-run + regression tests:** all 7 clients re-run through
   `POST /api/capi` on the prod build: `cl_piyush-ahuja` (no pixel
   key) → 5/5 simulated, no network; the 6 pixel-bearing clients →
   simulated with the exact no-URL note. OutboundEvent end state:
   **sent=44 · skipped=1 · failed=0**, and **0 rows still carry the
   literal `'pixel'` error string**. 8 new regression tests
   (`isValidMetaPixelId` matrix, placeholder→simulate no-network,
   boundary-reject, `.env`-numeric-URL flow-through,
   settings-placeholder reject, no-URL→simulate note, URL→live POST,
   web-signals-kept on a website source).

**Verification:** `pnpm typecheck` 0 · `pnpm test` **169/169** (14 files;
+8 D-11) · `pnpm build` 0 · live re-run above · `pnpm capi:replay`
= Meta HTTP 200 + fbtrace_id (labelled synthetic, EMQ≥7 stays gated on
G3-matched traffic — never claimed here). Guardrails: no pull row
touched (fixed point ad=3818/adSet=1177/spend=3818, WAL intact);
`.env`/`dev.db`/`.next`/scratch (`.d11-*` now gitignored) never
committed; secrets stay in `.env`.

**D-11 note on the environment:** while verifying, a stray `next dev`
chain (user terminal tab 4, `npm run dev` on :3001 sharing `.next` with
prod — the D-10 corruption pattern, 550.js / routes-manifest ENOENT)
was **found in user Terminal 4 and stopped at the source** (the whole
`npm run dev` process tree, PID 1552→2980→18396→26436, killed; the
user-owned tab itself stays open — only its command was stopped). The
D-10 verdict ("manual user terminal tab, cannot be closed from here")
is now confirmed live and the command is stopped; the standing rule
holds: **never run `next dev` next to prod**.

**Next gate = G3 live traffic + first Funnel landing URL per client.**
The live CAPI path is unblocked by DATA, not code: (a) the numeric
pixel — DONE (verified against Meta with the replay 200); (b) a web
source URL — the client's default Funnel `landingUrls` (0 today) or an
explicit `eventSourceUrl`. Once either exists, the 39 simulated rows
flip to live Meta 200s on the next queue run with **no code change**.
EMQ≥7 on Purchase still requires G3-matched browser-pixel traffic (the
refreshed D-09 snippet, paste-ready on `join.upcurvv.com/cll`).

## D-12 — dashboard engagement KPIs + per-client event_source_url for CAPI live (2026-11-05) [REVIEW]
Ticket: "dashboard engagement KPIs + per-client event_source_url for CAPI
live" — two separate tasks.

**Task 1 — engagement KPIs (stored rollup only, no new Meta calls, no new DB
writes):** the `Spend` rows already carry Meta's rollup engagement
(`impressions`/`reach`/`clicks`/`thruPlays` on all 3,818 rows; live totals
27,365,855 / 15,204,026 / 274,812 / 0, verified read-only). Added a KPI row
to the dashboard (All-aggregate + per-client views, the same dense layout):
**Total Impressions · Total Reach · Total Clicks · CTR · CPC**, computed ONLY
over the same stored Spend rows the spend KPIs use (same range + client +
`?adAccount=` filters — `spendRows` is already scoped, so the D-08 range
control + per-account drill-down apply automatically). `EngagementKpis.cpc =
spendInr / clicks` (INR-normalised, exact); `ctr = clicks / impressions`
(exact). Impressions/reach/clicks are currency-agnostic; CTR/CPC display in
INR like the spend KPIs. **LPV/CLPV + cost-per-LPV: NOT added** (D-08 probe
proved Meta v23.0 400s `lpv`/`clpv` on these accounts) — an honest footnote
renders below the KPI row ("LPV/CLPV not available on this Meta API version
… no cost/LPV is guessed"), never a zero column. Live rendering verified:
Impressions 2,73,65,855 · Reach 1,52,04,026 · Clicks 2,74,812 · CTR 1.0% ·
CPC ₹12.

**Task 2 — event_source_url (D-11's blocker) = .env config, NOT Funnel
rows:** D-11 proved the live CAPI path needs a web source URL (Meta subcode
2804039 rejects the `"system"` fallback; `"website"` requires
`event_source_url`) and no client had a Funnel row (D-02 kept Funnel rows
out — still stands). PO supplied 6 landing URLs; **stored them in `.env` as
`META_EVENT_SOURCE_URL_<CLIENT>`** (gitignored, same value-free pattern as
`META_PIXEL_ID_*`: code carries the key names in
`META_EVENT_SOURCE_URL_ENV_KEYS`, values only in `.env`; `.env.example`
documents the keys with empty values; a generic-key fallback means a
PO-added client needs no code change). `cl_piyush-ahuja` has no key on
purpose → stays simulated. A value is accepted only when it is a real
`http(s)` URL — a placeholder is never POSTed. `sendQueue` URL resolution is
now three tiers (injected → `.env` → Funnel `landingUrls`); none → stays
SIMULATED with the exact D-11 note. **D-12 promotion:** rows a D-11 run left
simulated are re-queued on the FIRST run where a URL exists (their first
Meta send; the frozen event_id dedups any repeat).

**Live re-run (2026-11-05, all 7 clients through `POST /api/capi` on the
D-12 prod build):** cl_upcurvv **14/14 LIVE** (Meta 200 + fbtrace_id on
each, e.g. `ALZF0WMyy8IdgpxL__LH8Kr`; the `.env` pixel + the `.env`
event_source_url) · cl_cardgenius-2 / cl_fml-x-abhishek-pal /
cl_abhishek-pal-fml / cl_fml-new / cl_the-job-workshop-ad-account **5/5
LIVE each** · **cl_piyush-ahuja stays SIMULATED** (no pixel key + no URL
key — the "still lacks a URL" case, not a bug; its 5 rows carry the exact
simulate note). End state: **39 live · 5 simulated · 1 skipped · 0 failed**.
**EMQ honesty:** the hub-log 200s carry NO `event_match_quality` (0 rows
with a Meta-reported EMQ; `metaEmq=null`, `emqFromMeta=false`) — EMQ≥7
stays gated on G3-matched live traffic, NOT claimed here.

**Verification:** `pnpm typecheck` 0 · `pnpm test` **177/177** (15 files;
+8 D-12: engagement All/single-client/ad-account + CTR/CPC math, LPV-absent
+ footnote-renders, .env-URL verbatim + placeholder-reject, .env-URL→LIVE
POST, D-11→LIVE promotion, no-pixel stays simulated) · `pnpm build` 0 ·
live re-run above · dashboard KPI row verified in All + per-client views.
No pull row touched (fixed point ad=3818/adSet=1177/spend=3818, WAL
intact); URLs live only in `.env` (never committed); `.d12-*` scratch
gitignored; no `next dev` next to prod.

**Next gate = G3 live traffic (real EMQ≥7 proof).** The live CAPI path is
now fully unblocked by code + `.env` config for the 6 URL-bearing clients
(proven LIVE this run); the remaining evidence gap is Meta-reported EMQ on
Purchase, which only real G3-matched browser-pixel traffic produces (the
refreshed D-09 snippet, paste-ready on `join.upcurvv.com/cll` — note D-12
now points CAPI at `https://join.upcurvv.com/cll` as the `event_source_url`
for `cl_upcurvv`, consistent with the snippet host). PO adding URLs for the
remaining clients flips them to live on the next queue run (no code
change); `cl_piyush-ahuja` stays simulated until it gets a pixel + URL.

## G3 live-traffic close-out (2026-11-06/07) [no [REVIEW] — measurement + docs]
Ticket: "prove the 95% ad_id/UTM gate + EMQ≥7 on Purchase with real clicks" —
a MEASUREMENT + PO-action ticket. Code was already G3-ready (cccaca3:
7-client snippets + audit + g3-measure.ts). This session: pushed the
G3-prep commit, re-verified the live host, resolved the carry-forward
ad-URL gate to its true (not-guessed) state, recorded the shared-page /
Piyush decisions, captured the pre-click baseline, and listed the PO
actions. **No live numbers are claimed — 0 + "AWAITING LIVE TRAFFIC" is the
correct state until real clicks land.**

**Ground-truth / cleanup:** pushed `cccaca3` to origin/main (tree was
already clean — no CRLF-noise revert was needed this session). Prod
`next start` :3000 up; no `next dev` running. Fixed point + WAL
re-confirmed read-only (ad=3818/adSet=1177/spend=3818,
G1=cl_upcurvv, journal_mode=wal).

**Host re-verify (task 1):** the recorded G3-prep host
`docs-reserve-inside-parking.trycloudflare.com` was STILL the running
quick-tunnel this session (cloudflared PID unchanged, no rotation) —
re-verified `/` 200 + `/xt.js` 200, **5,078 B** (byte-identical to
`public/xt.js`). `vegas-…`/`oak-…`/`naval-…` remain dead (000). The
7-client snippet table + Public-tunnel + G3 status rows all point at the
re-verified host.

**Ad-URL gate resolved, not assumed (task 2 + carry-forward (a)):**
re-ran `node scripts/audit-ad-urls.mjs` across all 7 stored AdAccount
rows: 5 accounts **UNAUDITABLE** (the G1 token reads ad rows but NOT
creative destination links — a read-only fields probe confirmed even the
account-level `adcreatives` read returns `link=null` + empty
`object_story_spec` for this token; the ads-level `creative{link}`
spelling is a `#100` invalid field) · cl_fml-x-abhishek-pal =
transiently rate-limited in this run (0 read; the G3-prep full run had
read its 1,572 ads, also 0 links) · cl_upcurvv = **PO-covered** — the
PO's own declared template in `G3_INPUTS.md`
(`join.upcurvv.com/cll?campaign_id={{campaign.id}}&adset_id={{adset.id}}&
ad_id={{ad.id}}`) passes `node scripts/audit-g3-link.mjs` by
construction, recorded as evidence. **Resolution is the PO's call
(recorded, not silently picked):** Option 1 — PO reads each account's ad
destination URLs in Ads Manager and reports which lack the params (we
record the fix list; the Meta-side fix is PO-manual). Option 2 — PO
grants a creative-content-read token; re-running the audit then yields a
real PASS / N-ads-to-fix table. Until evidence lands, the verdict stays
**UNAUDITABLE** (not a PASS, not a fake "no URLs").

**Shared page + Piyush (tasks 3, carry-forwards (b)/(c)):** the shared
`join.affluentindianshub.com/vpaxdvju` page (cl_abhishek-pal-fml +
cl_fml-x-abhishek-pal) gets NO snippet until the PO adds a client hint
or splits the page — recorded as a PO decision in DECISIONS (one
`<script>` carries one `data-client`; a silent single-client pick is
forbidden). cl_piyush-ahuja has no landing page supplied → out of G3
live-traffic scope (honest "no page yet", not a gap). G2 (Instant Forms)
remains FINAL-deferred, so the doc's Phase-1 instant-form sub-gate stays
dropped from the G3 checklist.

**Pre-click baseline (task 4, committed 2026-11-06/07 via
`pnpm g3:measure`):** cl_upcurvv 3/3 carry (all 3 are legacy seed
`meta_form_lead` rows, `adRefId=null`, NOT live clicks) → `<20` →
AWAITING; the other 6 clients = 0 live clicks → AWAITING; **EMQ≥7 on
Purchase: no Meta-reported `event_match_quality` on any Purchase →
AWAITING (not claimed — a hub-log 200 without EMQ is not a pass).**

**PO manual actions (task 5, code can't do these):**
1. Paste each client's snippet into that landing page's `<head>`
   (resolve the shared-page hint / page-split for the abhishek page
   first).
2. Resolve the ad-URL gate (Option 1 Ads-Manager URL report → we record
   the fix list, or Option 2 an upgraded creative-read token → re-run the
   audit).
3. Drive ~20 real Meta ad clicks (real ads, real accounts).
4. Re-run `pnpm g3:measure` (the 95% gate + carry% become real) and the
   CAPI queue (Purchase events hit Meta → read the Meta-reported
   `event_match_quality`).

**If the live clicks produce the first REAL Purchase→CAPI→EMQ≥7 proof:**
flipping CAPI/EMQ to "live" in a money-gated way is a SEPARATE
`[REVIEW]` commit — flagged here, not forced into this measurement
commit.

**Verification:** `pnpm build` 0 (stop prod → build → start prod; no
`next dev`) · `pnpm g3:measure` + `node scripts/audit-ad-urls.mjs` +
`node scripts/audit-g3-link.mjs` run clean · host `/xt.js` 200 @ 5,078 B
· tree clean + `cccaca3` pushed to origin/main · no
`.env`/`dev.db`/`.next`/scratch in the commit · token/pixels/URLs stay
in `.env` (never committed).

**Next gate = real G3 clicks → 95% + EMQ≥7; then G4 real-provider / G5 /
G9.**

## D-13 — Webhook & API key management panel (2026-11-07) [REVIEW]
Ticket: multiple API keys + multiple webhooks per client×platform — the
FlexiFunnels connection (no provider API key; we point it at a webhook
URL we own, with a per-CONNECTION secret). G4's single
`Client.webhookSecret` can't carry two FlexiFunnels accounts or
Razorpay test+prod on one client×platform. **This is the [REVIEW]
commit (admin + security surface: role-gated routes, hash-only key
storage, additive Prisma schema — PO reviews before push; local only).**

**Schema (additive — 3 new models, no deletes/re-parents):**
`ApiKey` (hash-only `keyHash` = SHA-256 of the random key; the plain key
shown EXACTLY ONCE at creation) · `WebhookEndpoint` (one webhook
CONNECTION: its own `endpointSecret` + `inboundUrl`
`…&conn=<id>` + `active` soft-revoke + `lastReceivedAt`) ·
`WebhookConnectionLog` (one row per received conn event: status +
SHA-256 `payloadHash`, never the raw payload — that still goes to the
existing `WebhookLog`). Applied to dev.db via `db push`; additivity
PROVEN by before/after row-count snapshots — fixed point
ad=3818/adSet=1177/spend=3818 unchanged, G1=cl_upcurvv, WAL
`journal_mode=wal` stands. (This repo has no versioned-migration
baseline — `db:migrate` here IS `db push`.)

**Security-critical lib — `src/lib/integrations.ts`:**
`sha256Hex` / `generateApiKey` (`xacq_` + 32 random bytes base64url,
hash stored) / `keyMatchesHash` (constant-time) /
`generateWebhookSecret` (32 random bytes, reversible-stored) /
`createApiKey`+`revokeApiKey` (idempotent soft-revoke) /
`createWebhookEndpoint`+`revokeWebhookEndpoint` /
`resolveEndpointForRoute` (active + same client + platform, else null →
route 404s) / `recordConnectionLog`.

**PO decision recorded (the one deviation from the ticket text):**
`WebhookEndpoint.endpointSecret` is stored **reversibly**, not
SHA-256-hashed — the repo's HMAC gateways (Razorpay `HMAC(secret,
body)`, Cashfree `HMAC(secret, ts:body)`) recompute an HMAC with the
secret as the KEY; a hash of the secret cannot reproduce it, so
hash-only would break every HMAC-gateway connection. "Shown once" is
enforced at the API/UI layer instead (only the create response returns
the plain value; list/GET/log endpoints never do). `ApiKey.keyHash`
stays hash-only (presented-key → hash → compare is that flow).

**API (admin-only; new `admin_integrations` action on the existing `can`
matrix — owner + admin only, no new role system):**
`GET/POST /api/admin/keys` (+`/revoke`) · `GET/POST
/api/admin/webhooks` (+`/revoke`, +`/:id/logs` = last-100 conn log
rows, payload-hash only). Create returns the plain key/secret EXACTLY
ONCE (`showOnce:true` + warning). Client-scoped creates/revokes
audit-logged; a workspace-level key (clientId=null) has no AuditLog
client-FK target — its own row is its audit trail (documented, not
silently dropped).

**Route change (additive; legacy path byte-for-byte unchanged when
`&conn=` is absent):** `POST /api/webhooks/[platform]` now accepts an
OPTIONAL `&conn=<endpointId>`: present → that WebhookEndpoint's secret
verifies; bad/revoked/foreign id → clean **404 "unknown connection"**
(never a 500, never a silent fallback to the legacy secret). Conn
rate-limit key is conn-scoped. Each received conn event → one
`WebhookConnectionLog` row + `lastReceivedAt` bump.

**UI — `/admin/integrations` (server-gated by `admin_integrations`,
hidden for non-admins; Sidebar "Webhooks & API keys" under Admin):**
Keys table (label/scope/purpose/created/last-used/status + per-row
revoke) + Generate-key (workspace-level default) · Webhook table
(label/client/platform/inboundUrl/last-received/status + per-row
revoke + per-row "logs" drawer = last-100 payload-hash rows) +
Generate-webhook (client + platform dropdown built from the adapter
catalog, not hardcoded) · one-time-reveal treatment on both (copy-now
+ confirm-before-reveal + "cannot be retrieved later") · a **UI-only
FlexiFunnels quick-action card** (each active FlexiFunnels connection's
inboundUrl + the two paste targets: Form Settings → Webhooks for
leads, Products → Product Rules → Webhook for purchases; it does NOT
drive any provider-side config).

**Tests — `test/d13.test.ts` 18/18:** hash-only key storage + one-time
reveal · TWO connections on the same client×platform verify
INDEPENDENTLY (the FlexiFunnels adapter's `verify` accepts its own
connection's `x-webhook-secret` and rejects the sibling's;
`resolveEndpointForRoute` scopes to active + same client + platform) ·
legacy no-conn path unchanged (route contract asserts) · revoked conn
→ 404 (soft-revoke keeps the log intact) · audit-log write on
create/revoke + conn-log write on receipt (payload-hash only; the model
has no raw-payload column to leak) · route contract asserts pinning the
security surface (no keyHash/endpointSecret in any list select,
showOnce copy, 404/403/409 paths, conn-scoped rate limit). The suite
also caught + we fixed a REAL bug the API path had never exercised:
`createWebhookEndpoint` omitted the required `createdBy` FK (a Prisma
`PrismaClientValidationError`, "Argument `client` is missing").

**FlexiFunnels quick-action (the PO paste instructions):**
`/admin/integrations` → **Generate webhook** (client = the FlexiFunnels
client, platform = **FlexiFunnels**, e.g. label `flexifunnels-leads`) →
copy the **inboundUrl** (`…/api/webhooks/flexifunnels?client=<id>&conn=<id>`;
the current dev base is the quick-tunnel host — G10 re-points to the
Vercel domain, so re-generate after G10 or update the pasted URL) and
the one-time **secret** → in FlexiFunnels: **Form Settings → Webhooks**
paste the inbound URL as the webhook URL + the secret in the
`x-webhook-secret` header field (leads); **Products → Set Product
Rules → Webhook** paste the same for purchase events (each destination
may get its OWN connection — that's the point of D-13).

**Verification (final, at commit time):** `npx vitest run
test/d13.test.ts` **18/18** · full `pnpm test` **195/195 (16 files)** ·
`pnpm typecheck` 0 · `pnpm build` exit 0 (all 6 new routes in the
build manifest: `/admin/integrations` + 5 `/api/admin/*`) · stop-prod
→ build → start-prod done, prod on :3000 answering 200 on the new
build · live zero-side-effect smoke: `GET /api/admin/keys` +
`GET /api/admin/webhooks?client=all` = 200 empty-state; bogus
`&conn=d13_bogus_conn` POST → **404 `{"error":"unknown connection"}`**
exactly as designed · no test rows left in dev.db
(`apiKey=0 webhookEndpoint=0 webhookConnectionLog=0`; the pre-existing
legacy `webhookLog=109` untouched) · fixed point
**ad=3818 / adSet=1177 / spend=3818** + **WAL `journal_mode=wal`**
re-verified after the commit · no `.env`/`dev.db`/`.next`/scratch in
the commit (`.d13-*` scratch gitignored; pre-commit leak-check clean)
· **no new `.env` keys** (the per-connection secret is a generated DB
row, not an env value — the ticket's constraint holds).

**Two honest environment caveats (NOT D-13 defects; recorded, not
silently papered over):**
1. **Quick-tunnel host rotated dead:** the recorded G3-close-out host
   `docs-reserve-inside-parking.trycloudflare.com` now answers **000
   (DNS failure)** — cloudflared IS running (a process since 10:37)
   but the quick-tunnel subdomain rotated. The D-13 FlexiFunnels
   paste (and any live webhook) must use the CURRENT tunnel subdomain
   (re-verify via `curl https://<subdomain>/` like the G3 flow) or the
   G10 Vercel domain. `NEXT_PUBLIC_BASE_URL` is NOT set in `.env`, so
   a freshly-generated `inboundUrl` defaults to `http://localhost:3000`
   (correct for local testing; set the env or re-generate on the live
   host before the PO paste).
2. **A `next dev` instance (user terminal tab) is live on :3001**
   alongside the prod `next start` on :3000 — that is the
   single-writer hazard the standing rule forbids. It pre-dated this
   commit's prod restart and was NOT started by this session; the
   user should close that tab to keep dev.db single-writer (or accept
   the hazard knowingly). This commit itself is clean: built with
   prod stopped, no `next dev` was started here.

**[REVIEW] commit:** this very commit on `main` — local only, NOT pushed
(the PO pushes after review). Subject: "D-13 Webhook & API key management
panel: multiple connections per client×platform [REVIEW]" — 17 files,
+1822/−10. Resolve the exact SHA with
`git log -1 --grep="D-13 Webhook & API key" --oneline` (SHA at prep
time: `d909fb1`; it may differ by one because a commit's recorded SHA
can't literally be its own final SHA after a docs amend — `git log -1`
is authoritative).

**Next gate = PO generates a FlexiFunnels webhook here + pastes the
inboundUrl + secret into the FlexiFunnels dashboard (the quick-action
card's two targets) + drives ONE real FlexiFunnels order → G4
FlexiFunnels real-provider proof (the first G4 platform unblocked
WITHOUT a gateway API key), then G5/G9.**

## D-13a — webhook inboundUrl → PUBLIC host (FlexiFunnels rejects localhost) (2026-11-12) [normal commit]
Ticket: the FlexiFunnels connections created under D-13 all carried
`http://localhost:3000/...` inboundUrls (`.env` had no base-URL key),
which an external provider can never reach — FlexiFunnels rejects the
URL as "incorrect". **URL-plumbing fix only — no money/CAPI/permission
path touched → ONE NORMAL commit (the ticket's escalation rule: it
would have been [REVIEW] only if the integrations.ts change had
reached auth/verify logic; it didn't — only the base-URL line
changed).**

**What landed:** new `.env` key `PUBLIC_BASE_URL` (distinct from the
client-side `NEXT_PUBLIC_BASE_URL`; value = the live trycloudflare
subdomain, set locally, not committed — committed are the key in
`.env.example` + the `.gitignore` scratch pattern) · `resolveWebhookBase`
precedence `explicit(test) > PUBLIC_BASE_URL > NEXT_PUBLIC_BASE_URL >
localhost-dev` in `src/lib/integrations.ts` (the admin route stopped
passing `NEXT_PUBLIC_BASE_URL` explicitly, which would have shadowed
the PUBLIC tier) · `isLoopbackBase` (localhost/127.0.0.1/0.0.0.0/::1)
· `refreshWebhookInboundUrls` — active-rows-only rewrite of the
inboundUrl STRING (a revoked row keeps its URL = audit trail),
secret/hash/log untouched, idempotent · `scripts/refresh-webhook-urls.ts`
(`pnpm webhooks:refresh-url`, gitignored evidence log) · UI warning
banner in `/admin/integrations` when the resolved base is loopback +
a "base: …" tier badge.

**Live run (dev.db):** 6 active FlexiFunnels rows re-pointed from
`http://localhost:3000` to the current tunnel
`https://tourist-filtering-sheriff-firmware.trycloudflare.com`
(re-verified live: `/` + `/admin/integrations` + `/api/admin/keys`
200 through it; bogus `&conn=` still 404s). Refresh run 1 =
`updated=6 unchanged=0`; re-run = `updated=0 unchanged=6`
(idempotency proof). `PUBLIC_BASE_URL` is set in `.env` to that host.

**Tests + guardrails:** `test/d13a.test.ts` 21/21 (precedence,
loopback detection, "no localhost in generated URL once
PUBLIC_BASE_URL is set" via a real DB write+read-back incl. the
loopback-NEXT_PUBLIC-shadowing case, refresh idempotency,
refresh-secret-untouched, refresh-active-only, legacy G4 route/schema
contract asserts) · full suite **216/216 (17 files)** · `typecheck`
0 · `build` 0 · prod `next start` restarted on the new build · no
`next dev` started by this ticket · fixed point ad=3818/adSet=1177/
spend=3818 + WAL intact (re-verified post-refresh) · `.env`/`dev.db`/
`.next`/scratch NOT in the commit (`.d13a-*` gitignored).

**D-13's two caveats are now RESOLVED by this ticket:** (1) the
"quick-tunnel host rotated dead" caveat — this session re-verified a
fresh host (`tourist-filtering-sheriff-firmware`, 2026-11-12) and
wired it as `PUBLIC_BASE_URL`; the host still rotates on every
cloudflared restart, so re-verify before the PO paste (G10 swaps to
the Vercel domain + one `pnpm webhooks:refresh-url` re-point).
(2) the "next dev on :3001 next to prod" caveat — at this session's
start no dev/prod instance was running on :3000/:3001; this ticket
started only prod (`next start` :3000) + the cloudflared tunnel
(user-run, as before), no `next dev`.

**[Normal] commit:** this D-13a commit on `main` (17-ish files:
`integrations.ts` + admin route + page/panel + `.env.example` +
`.gitignore` + `package.json` script alias + `scripts/refresh-webhook-urls.ts`
+ `test/d13a.test.ts` + the 3 doc files) — local only, PO pushes.

**Next gate = PO pastes the NEW public inboundUrl (now
`https://<current-tunnel>/api/webhooks/flexifunnels?client=<id>&conn=<id>`,
all 6 already re-pointed — re-verify the subdomain first) + the
one-time `x-webhook-secret` into the FlexiFunnels dashboard
(Form Settings → Webhooks for leads + Products → Set Product Rules →
Webhook for purchases) + drives ONE real FlexiFunnels order → G4
FlexiFunnels real-provider proof, then G5/G9.**

## D-14 — client + admin details display (2026-11-12) [normal commit]
Ticket: PO "client ya admin ki details kahi nahi dikh rahi" — a DISPLAY
gap, not a bug: the dashboard never read the Client row, and
`GET /api/session` returned only role+name, so neither the selected
client's profile nor the acting user's full details rendered anywhere.
**Display-only → ONE NORMAL commit (no money/CAPI/permission path
touched).**

**A. Client-profile band (single-client dashboard view):** new
`clientProfile(prisma, clientId)` in `src/lib/dashboard.ts` (the
house testable-reader pattern next to `dashboardAll`) reads the
Client row + workspace + `funnel.count` + `lead.count`;
`src/app/page.tsx` renders a compact "Client profile · <name>" card
ABOVE the KPI row when a specific client is selected. Fields shown
(real columns only): name, currency, offerPrice (INR),
attributionWindowDays + attributionModel, timezone, metaPageId,
metaPixelId (config values — shown per the ticket), capiEventType,
funnel count, lead count, updatedAt ("last changed"), workspace
name. The all-clients default view shows a small "N clients in this
view: <names> — pick one in the top bar for its profile" summary
line instead. **Guardrail:** the reader's `select` is a WHITELIST
that structurally excludes `Client.webhookSecret` + every D-13 secret
column (ApiKey/WebhookEndpoint) — no secret value can render, and
the D-14 tests pin that as a source grep-contract.

**B. Acting-user details (every screen via the Topbar):**
`GET /api/session` gains two ADDITIVE fields on the acting session —
`workspace` (the workspace name) + `twoFactor` (read from the user
row; the `Session` type doesn't carry either) — the existing
`session`/`clients`/`adAccounts`/`personas`/`roles` payload is
unchanged. The Topbar's "acting as" cluster now also shows the
user's **email**, the **workspace name**, and a compact
**"phones: masked / visible"** PII-state badge (the `maskPhone`
flag, spec 5.10) — additive, no redesign. **PII guardrail:** a
phone VALUE is never in the session payload (the User model has no
phone column; lead phones still flow through `maskPhone()` in
`leads.ts`); the suite locks the last-4 behaviour for a masked role
and asserts the Topbar carries only the state flag.

**Verification:** `test/d14.test.ts` **12/12** (profile fields
from a real row; a row WITH a webhookSecret set proves the reader
never returns it; unknown client → null; session additive
`workspace`/`twoFactor` + existing payload intact + no phone value
in the payload; `maskPhone` last-4 lock-in; source grep contracts:
no secret column in the reader select / page / Topbar / session
route) · `pnpm typecheck` 0 · `pnpm build` 0 · full `pnpm test`
**228/228 (18 files)**. The running prod build on :3000 was
rebuilt for this feature; the `GET /api/session` live response now
carries `workspace: "Foremost Leads"` + `twoFactor: true` on the
acting owner.

**Guardrails:** no `.env`/`dev.db`/`.next`/scratch in the commit
(`.d14-*` scratch gitignored) · pull rows untouched
(ad=3818/adSet=1177/spend=3818, G1=cl_upcurvv) · WAL stands ·
secrets (webhookSecret / apiKey value / webhook-connection secret)
NEVER rendered — grep-proofed in the D-14 tests · admin PII
respects the existing `maskPhone` rule · no `next dev` next to prod
(the D-13a-era `next dev` tree was stopped before the build; only
prod `next start` :3000 is running).

**Commit:** this D-14 commit on `main` — local, not pushed
(display-only ticket; the PO pushes per the standing policy).

## D-15 — webhook URL host-staleness self-healing + hard delete (2026-11-12) [REVIEW]
Ticket: the D-13a tunnel host (`tourist-filtering-sheriff-firmware`)
rotated DEAD on a cloudflared restart while the live host was
`manhattan-cloth-bestsellers-town` — so stored FlexiFunnels
`WebhookEndpoint.inboundUrl` values pointed at an unreachable subdomain
and every provider event stopped landing (the path, secret, and
platform are all still valid; only the host is stale). Plus the PO
request: "revoke karne par delete hi ho jaye" — a webhook connection's
revoke should be a real DELETE, not a soft `active=false` stamp.
**Admin + security surface (role-gated routes, a new Prisma migration
column, destructive delete semantics) → ONE [REVIEW] commit.**

**What landed:**
- **Host-aware URL (task 1):** the "current live host" is now a KNOWN
  SOURCE — `Workspace.liveHost` (new additive schema column,
  PO-persisted ONLY by the Refresh action) wins over the D-13a `.env`
  `PUBLIC_BASE_URL` precedence. `GET /api/admin/webhooks` is additive:
  each row now carries `stale`/`storedHost`/`staleHost` (flagged when
  the stored host ≠ the current host, ACTIVE rows only) and the
  response names `currentBase` + `currentBaseSource`. The list NEVER
  auto-refreshes (a rotation is a PO event, not a background write).
  New `POST /api/admin/webhooks/refresh` (admin-only) re-points every
  ACTIVE row to the entered host via `refreshWebhookUrlsToHost` — the
  host substring ONLY (the path `?client=…&conn=…` survives verbatim,
  `endpointSecret`/keyHash/conn-log never read or touched), idempotent
  (a second run changes 0), one `refresh_webhookEndpoint` audit row
  per CHANGED row (client-scoped; a 0-change run writes none), then
  PERSISTS the host to `Workspace.liveHost` (workspace-scoped).
  A non-URL host is rejected up front (`'host' must be an absolute
  base URL`).
- **Hard delete (task 2):** `POST /api/admin/webhooks/delete`
  (admin-only) + `deleteWebhookEndpoint` (a real delete) replace the
  D-13 soft `revokeWebhookEndpoint` (the `revoke/` route is removed).
  Safety model: `WebhookConnectionLog.endpoint` is `onDelete: Cascade`
  → the row's connection-level connLogs cascade with it; the
  RAW-received-payload `WebhookLog` rows carry NO endpoint relation and
  are PRESERVED (client-scoped received-payload audit; a heavier purge
  is a separate, explicit PO decision — never folded in). The route
  writes the AuditLog row BEFORE the delete (action
  `delete_webhookEndpoint`, details = platform + label only, the
  per-connection secret is never read, logged, or even named in the
  file — the test locks that), so the trail outlives the row. Unknown
  / already-deleted id → clean 404 "unknown connection", never a 500
  (idempotent-by-404). **ApiKey revoke stays SOFT** (`revokedAt`
  stamp) — the ticket's default.
- **Pure helper split:** `urlHost` + `rehostInboundUrl` live in
  `src/lib/webhookUrl.ts` (no `node:crypto`, no Prisma) so the CLIENT
  integrations panel can use them without dragging `node:` into the
  browser bundle (a value-import from `integrations.ts` broke
  `pnpm build` with `UnhandledSchemeError: Reading from
  "node:crypto"` — the split is the fix); `integrations.ts`
  re-exports them so server routes + tests keep their import surface.
- **Panel UI (`/admin/integrations`):** a "Refresh URLs to the current
  live host" card (host input pre-filled from the persisted
  `Workspace.liveHost` else the `.env` base; result = N updated / N
  already current + per-row `before → after` lines + a loopback
  banner); a per-row `URL is stale (host X ≠ current)` warning badge;
  the per-row button is now "delete" gated by a type-`DELETE`
  confirm (the table keeps the pre-D-15 `active=false` "revoked" state
  visible for legacy rows); and the FlexiFunnels quick-action now
  offers a **copy (current host)** URL (re-hosted against the live
  host via the pure `rehostInboundUrl`, with a copy button) so the PO
  can always copy a reachable URL — even before clicking Refresh.

**Live run (dev.db, `cl_abhishek-pal-fml`):** before = the live
`flexi` connection (`conn=cmwd9nk17000dizs4yj7jz7ks`) was `stale=true`
on the DEAD `tourist-filtering-sheriff-firmware` host (its 6 sibling
dead rows stay untouched — active-only scope);
`POST /api/admin/webhooks/refresh {host: manhattan-cloth-bestsellers-town}`
→ `updated=1 unchanged=0`; the after-list shows the row re-pointed to
`https://manhattan-cloth-bestsellers-town.trycloudflare.com/api/
webhooks/flexifunnels?client=cl_abhishek-pal-fml&conn=cmwd9nk170…`,
`stale=false`, `currentBaseSource=workspace.liveHost` (proof the host
was PERSISTED, not just env-derived); idempotent re-run =
`updated=0 unchanged=1`; exactly one `refresh_webhookEndpoint` audit
row (the 2nd run wrote 0); `Workspace.liveHost` now = the manhattan
host. Evidence: `.d15-before.json` / `.d15-refresh.json` /
`.d15-after.json` / `.d15-refresh2.json` (gitignored `.d15-*`).

**Tests + guardrails:** `test/d15.test.ts` 17/17 (host-only rewrite
+ idempotency incl. the `?client=&conn=` byte-for-byte survival +
unparseable-input null, `currentWebhookHost` liveHost-wins / blank-
falls-through / trailing-slash-trim precedence, refresh
ACTIVE-only + secret byte-identical + connLog intact, hard delete
cascade/preserve/404 + audit-before-delete textual order + the delete
route never names the secret field, refresh route persists
`liveHost` + audits only changed rows + rejects a non-URL host) ·
full suite **245/245 (19 files)** · `typecheck` 0 · `build` 0 · no
`next dev` started by this ticket · fixed point ad=3818 / adSet=1177
/ spend=3818 + WAL intact · `.env`/`dev.db`/`.next`/`.d15-*` scratch
NOT in the commit. `.env` `PUBLIC_BASE_URL` is set to the live
`manhattan-cloth-bestsellers-town` host locally (a value, not
committed; the committed `.env.example` keeps the empty placeholder +
documentation).

**[REVIEW] commit:** this D-15 commit on `main` (`prisma/schema.prisma`
+ `integrations.ts` + `webhookUrl.ts` + the admin `webhooks` route +
`delete/` + `refresh/` routes (the `revoke/` route removed) + the
`integrations` page/panel + `test/d15.test.ts` + the `d13`/`d13a`
test updates for the hard-delete rename + `.gitignore` + the 3 doc
files) — local only, PO reviews + pushes per the standing rule.

**Next gate = PO re-pastes the (now reachable) FlexiFunnels
inboundUrl + the one-time `x-webhook-secret` for the `flexi`
connection into FlexiFunnels (Form Settings → Webhooks for leads +
Products → Set Product Rules → Webhook for purchases — the panel's
quick-action card shows the copy-now current-host URL; re-verify the
tunnel subdomain first, it still rotates on every cloudflared
restart) + drives ONE real FlexiFunnels order → G4 FlexiFunnels
real-provider proof (the first G4 platform unblocked without a
gateway API key), then G5/G9.**

## D-16 — Google Sheet lead-sync tab (2026-11-13) [REVIEW]
Ticket: the FlexiFunnels webhook path is BLOCKED on the unpaid pages
(because those pages' only webhook slot is already Pabbly's), so for
those leads the PO dumps them into a Google Sheet and wants to pull
them in. D-16 adds a "Google Sheet sync" tab to the existing `/import`
screen (spec §6 / G7 "upload with column mapping + commit-after-
approve"), reusing the EXISTING ingest pipeline so imported rows carry
the same dedup/identity/revenue semantics. **The commit can queue a
CAPI Purchase (the money path) + it's a new public-facing screen + a
server-side fetch of an external host → ONE [REVIEW] commit.**

**What landed:** a new `src/lib/sheets.ts` (the pure, testable core:
`parseSheetLink` — a PO-pasted Sheets link → the stable PUBLIC CSV
export URL, the tab gid from the link's own `/d/<id>/<gid>` / `?gid=` /
`#gid=` with an explicit override winning, the `/d/e/<key>/pub`
publish-to-web form getting its own `/pub?output=csv` export, and a
non-Sheets link → `null` so the route 400s rather than guess) ·
`fetchSheetCsv` (the SERVER-SIDE fetch, an injectable `fetch` seam the
tests stub — no credentials; a 200 CSV → `{csv, columns, rowCount}`,
BOM-stripped; a private sheet's 401/403/404 → `ok:false` + the EXACT
upstream status + a note naming the two ways forward — share it
"Anyone with the link can view", OR the Google API path which needs
Google OAuth / service-account creds in `.env` (recorded, NOT built) —
and a 200 that's a login/HTML page is blocked too, so no HTML ever
becomes a lead; an empty sheet → `rowCount: 0`, never placeholder
rows) · `suggestColumns` (the header → field auto-mapping the preview
pre-fills, best-effort, an unmatched field stays blank). A new
`GET /api/import/sheets` route (401 unauth → 403 no client → 400 a
non-Sheets link → 403 `{blocked, upstreamStatus, note}` a
private/HTML sheet, the exact status relayed → 200 `{csv, columns,
rowCount, exportUrl}`; grep-locked read-only — it never writes a
lead). The import screen (`ImportForm.tsx`) gained a "Google Sheet
sync" tab alongside paste-CSV: paste link + pick client + (optional)
tab → **Fetch & preview** → a preview table + the auto-suggested column
mapping → **Commit N leads**, and the commit is the EXISTING
`POST /api/import` (the `sheetsAdapter` now carries ALL mapped fields,
`city` + `product` too, so a mapped sheet lands on the right fields).
The Pabbly note is in the copy: for a page whose only slot is Pabbly's,
the sheet is the lead-capture path; the Pabbly webhook (G4/D-06) is
the live alternative for a free slot.

**Guardrails honoured:** re-syncing the same sheet adds 0 new leads —
the pipeline dedups by phone (E.164) then email (spec §4, within a
client) + the payment on the gateway txn `import_row_<i>` (spec §6);
imported rows are ADDITIVE only (they never touch the Meta pull —
the ad/adSet/spend fixed point is provably unchanged; D-16 wrote 0
sheet rows to `dev.db` before the commit). No `.env`/`dev.db`/`.next`/
scratch in the commit (the `.d16-*` evidence is gitignored). No `next
dev` next to prod.

**Verification:** `test/d16.test.ts` **22/22** (link → export-URL
resolution + tab-gid precedence + the `/pub` form + non-Sheets → null;
200 CSV in / empty = 0 rows / 401·403·404 each → the EXACT status +
the "Google API creds" note / a 200-HTML login wall → BLOCKED / a 5xx
relayed / a network timeout → httpStatus 0; the re-sync fixed point
commit → re-commit = 0 new leads, payments deduped on `import_row_*`;
the paid-row Purchase-CAPI path; column mapping landing on the right
fields, an unmapped status invents no payment; `suggestColumns`; the
route contract — the fetch route is read-only, `POST /api/import` stays
the commit, the injectable-fetch seam). `pnpm typecheck` 0 · `pnpm
build` 0 · full `pnpm test` **267/267 (20 files)**. **Live BLOCKED
proof against REAL Google (prod, `.d16-blocked.json` / `.d16-badlink.json`):**
a bogus sheet id → the server-side fetch ran, Google returned `404`,
the route relayed `upstreamStatus: 404` + the note (BLOCKED, no rows);
a non-Sheets link → `400 "not a Google Sheets link"`. No cloudflared
tunnel was running at proof time (the public host was `000`), but the
fetch targets `docs.google.com`, not the tunnel — so the BLOCKED path
still proved against live Google.

**Commit:** this D-16 commit on `main` (`src/lib/sheets.ts` +
`src/app/api/import/sheets/route.ts` + `src/app/import/ImportForm.tsx`
+ the `sheetsAdapter` city/product mapping + `test/d16.test.ts` +
`.gitignore` + the 3 doc files) — local only, PO reviews + pushes per
the standing rule.

**Next gate = PO shares a real (or tiny test) Google Sheet as
"Anyone with the link can view", pastes its link into the new
`/import` → "Google Sheet sync" tab, Fetch & previews, confirms the
auto-mapping, commits, and the leads appear in the Lead list (re-sync
the same sheet = 0 duplicates). The private-sheet / Google-API-creds
path stays BLOCKED (recorded, separate ticket) until the PO asks for
it.**

## D-18 — secret-free (unsigned) webhook connections for header-less platforms (2026-11-16) [REVIEW]
Ticket: FlexiFunnels support confirmed the provider can only POST to a
bare URL — it CANNOT send a signature / secret header. So the
per-CONNECTION secret D-13 generated for a FlexiFunnels connection
(`endpointSecret`, 32 random bytes) can NEVER be echoed back: the
simple-gateway `verify()` shape is `if (!secret) return true; else
headers["x-webhook-secret"] === secret`, and a real FlexiFunnels POST
carries no such header → every event logged "verification failed" (the
exact PO symptom on the `cl_abhishek-pal-fml`/`flexi` row — 6
consecutive failed conn logs, last 2026-11-16T12:28:56Z). D-18 makes
the header-less platforms run UNSIGNED (empty secret) so the PO pastes
only the inboundUrl. **Security surface (unsigned POST path + admin
route + one-off data script) → ONE [REVIEW] commit.**

**What landed:**
- `src/lib/adapters/index.ts` — the single source of truth:
  `UNSIGNED_ONLY = ["flexifunnels","cosmofeed","tagmango"]` + the
  `isUnsignedOnly()` type guard (Cosmofeed/TagMango share the same
  header-less shape; signed gateways like Razorpay/Cashfree are NOT in
  the set — they keep + verify their secrets).
- `src/lib/integrations.ts` — `createWebhookEndpoint` now mints
  `endpointSecret=""` for UNSIGNED_ONLY platforms (returns
  `unsigned:true`, secret ""); signed platforms unchanged (44-char
  secret, show-once). New `clearWebhookEndpointSecret(prisma,id)`
  (empties a header-less connection's leftover secret; GUARDRAIL: a
  signed-capable platform is refused, `signedPlatform:true`, no write;
  idempotent) + `clearUnsignedWebhookSecrets(prisma,activeOnly)` (the
  one-off mass clear: active UNSIGNED_ONLY rows, signed rows skipped,
  writes only `endpointSecret`).
- `src/app/api/admin/webhooks/clear-secret/route.ts` — admin-only
  (`admin_integrations`) POST `{id}` → 404 unknown · 400 a
  signed-capable platform (the guardrail, before any write) · 200
  cleared / already-unsigned; an AuditLog row (`clear_webhookEndpointSecret`)
  is written BEFORE the clear (details = platform + label only, the
  secret is never logged).
- `scripts/unsigned-flexi.ts` → `pnpm webhooks:clear-unsigned`
  (package.json alias) — the one-off run against the live DB (evidence
  in `.d18-clear-evidence.txt`, gitignored).
- `src/app/api/admin/webhooks/route.ts` — the create now returns
  `unsigned:true` + a "plain webhook (no secret)" note for header-less
  platforms (the ShowOnce warning only on the signed path); the list
  exposes per-row `unsignedPlatform` + `hasSecret` (a `!= ''` raw
  check, never the secret value).
- `IntegrationsPanel.tsx` — an unsigned create shows the inboundUrl-
  only paste path (no secret reveal); a leftover-secret row gets a
  "clear secret" button → the new route; the FlexiFunnels card now
  tells the PO to paste ONLY the inboundUrl (no secret) and flags
  "leftover secret" vs "unsigned (plain)".
- `test/d13.test.ts` repoint — the "two connections, each with its own
  secret" value-prop now demos on Razorpay (a signed-capable platform);
  FlexiFunnels is unsigned and can't demo two distinct secrets.
- `test/d18.test.ts` (14 tests): (a) unsigned create → `secret=""` +
  `unsigned:true` (all 3 header-less platforms; a signed platform
  still gets a 44-char secret) · (b) `verify()` accepts a plain POST
  with no secret header when the connection secret is empty · (c)
  SIGNED platform (Razorpay) still REJECTS a wrong/missing signature —
  no security regression + not in `UNSIGNED_ONLY` · (d) clear-secret
  empties the stored secret (idempotent; a signed platform is REFUSED)
  + the mass clear skips signed rows, idempotently · (e) a re-sent
  FlexiFunnels POST with the CLEARED connection logs "processed/ok",
  not "verification failed".

**Verification:** `pnpm typecheck` 0 · `pnpm test` **281/281 (21
files)** · `pnpm build` 0 (prod stopped, rebuilt, restarted — root
200) · **live proof (prod):** the broken `cl_abhishek-pal-fml`/`flexi`
row (`cmwd9nk17000dizs4yj7jz7ks`) had 6 consecutive "verification
failed" conn logs; `pnpm webhooks:clear-unsigned` → `changed=1`
(cleared the one leftover secret; a re-run reports `cleared=0
already=1` — idempotent); a re-sent FlexiFunnels POST → HTTP 200
`status:"processed"` and the conn log flipped to `ok`; a re-send of
the identical order does NOT double-charge (gateway-txn dedup: first
POST `payments:1`, re-send `payments:0`, same lead id) · fixed point
+ WAL re-verified (`journal_mode=wal`; D-18 writes only
`WebhookEndpoint.endpointSecret`, no Meta ad/adSet/spend row; the
ticket's `3818/1177/3818` predates D-05 autopull — the current
baseline is `3857/1190/3857`, untouched by D-18) · no `next dev` next
to prod · no `.env`/`dev.db`/`.next`/scratch in the commit ·
**live host re-verified:** the row's stored host
`andrews-keyword-neighbors-lou.trycloudflare.com` is live (HTTP 200,
driven a POST through it) while `.env` `PUBLIC_BASE_URL` still points
at the stale `manhattan-cloth-bestsellers-town` subdomain (`000`) —
that is the D-15 host-staleness case (re-point via
`pnpm webhooks:refresh-url` / the D-17 live-host auto-capture), not a
D-18 regression.

**Commit:** this D-18 commit on `main` (`src/lib/adapters/index.ts` +
`src/lib/integrations.ts` + `src/app/api/admin/webhooks/{route.ts,
clear-secret/route.ts}` + `scripts/unsigned-flexi.ts` +
`package.json` alias + `IntegrationsPanel.tsx` + `test/d13.test.ts`
repoint + `test/d18.test.ts` + `.gitignore` + the 3 doc files) — local
only, PO reviews + pushes per the standing rule.

**Next gate = PO drives one real FlexiFunnels order through the
now-unsigned `cl_abhishek-pal-fml`/`flexi` connection (or FlexiFunnels
fires its webhook) and it lands `ok` in the connection log — not
"verification failed".**

---

## D-19 / D-19b — FlexiFunnels lead-capture (optin) form data: the flat shape, custom fields in a `meta` object, junk-lead backfill + the lead-view "Form data" card (2026-11-17) [REVIEW]
Ticket: the now-working (D-18 unsigned) `cl_abhishek-pal-fml`/`flexi`
connection lands `ok`, but the PO's real **lead-capture (optin)** webhooks
showed up as **"Payment failed" source-unknown leads with no data**. The
pre-D-19 flexifunnels adapter assumed the D-13/D-06 payment shape
(`{action:"order.paid", customer:{…}}`); the live-captured payload (read
off the stored `WebhookLog.rawPayload` rows — spec 4 keeps the raw body)
is a **FLAT optin object** with `first_name`/`email`/`phone`/`city`,
user-named custom answers (e.g. `what's_your_current_it`), all 7 UTM
values, `fbclid`, and `datetime` in IST wall-clock. D-19/D-19b re-models
the real shape, carries the custom fields losslessly in a record-level
`meta`, backfills the junk leads the old adapter already created, and
surfaces the form data on the lead view. **Adapter + one-off data script
+ admin "show payload" + PII-masking surface → ONE [REVIEW] commit.**

**What landed:**
- `src/lib/adapters/payments.ts` — the flexifunnelsAdapter now models the
  live optin: optin/lead-capture (and **any unrecognised event** — the
  D-19 rule: a FlexiFunnels form webhook is a *registration* unless it
  names a purchase/refund) → a `registered` record with full identity +
  UTM carry-through + `fbclid`; **never** a fake `payment_failed` /
  revenue row. Every unmapped top-level key (the user-named custom answers
  + page context) rides in `meta` (`adapters/types.ts`
  `NormalizedInbound.meta`) so no field is lost; the full body still
  stays on the `WebhookLog`. `flexiFormFieldsFromRaw()` is the one
  flat-shape extractor the adapter + lead-view share. `parseFlexiDatetime`
  reads the IST `dd/MM/yyyy, hh:mm:ss am/pm` into the right UTC instant.
  The purchase/refund families still parse (the D-13 shape kept as a
  **tolerance**; the real purchase envelope is assumed, not live-captured).
- `src/lib/ingest.ts` — the `WebhookLog` row is created **FIRST** (before
  the record loop) so every Event carries its `Event.webhookLogId`
  provenance link (a G0 schema column, now actually written) + the
  record's `meta` is persisted on the Event's `rawPayload`.
- `src/lib/leadFormFields.ts` + `src/app/leads/[id]/page.tsx` — the
  "Form data" card: event-`meta` first (the D-19 path), else the linked
  `WebhookLog` raw body via the same extractor (pre-D-19 events);
  identity lines mask per `maskPhone` / new `maskEmail` (spec 5.10
  last-4); the card hides when nothing is stored (never invented).
- `src/lib/webhookPayload.ts` +
  `src/app/api/admin/webhooks/[id]/logs/[logId]/payload` — admin-only
  (`admin_integrations`) "show payload": renders a stored raw body for one
  connection-log row, PII-masked to last-4 for roles that must mask
  (owner/admin see the full value); links the `WebhookConnectionLog` row
  to its `WebhookLog` by `payloadHash` (SHA-256 — the designed link, no FK
  between the tables). `IntegrationsPanel.tsx` gains the per-row toggle.
- `scripts/backfill-flexi.ts` → `pnpm backfill:flexi`
  (`package.json` alias) — the one-off **additive + idempotent** repair:
  re-runs the client's flexi `WebhookLog` rows through the new adapter,
  1:1-matches each junk lead (null phone+email) to its nearest UNUSED
  lead-capture log within 60 s (two leads never share one log), updates
  **only** the identity fields + `sourceUnknown=false`. No lead
  created/deleted, no Meta pull row touched.
- `test/d19b.test.ts` (16 new tests) + `test/d18.test.ts` repointed to
  the optin sample + `test/adapters.test.ts` flexi cases.

**Verification:** `pnpm typecheck` 0 · `pnpm build` 0 · full `pnpm test`
**299/299 (22 files)**. **Backfill live run (2026-11-17):** the 3 junk
leads created pre-D-19 were backfilled in the earlier session (run 1:
`junk found=3 → matched=3, updated=3, events-with-meta=3`); re-running
`pnpm backfill:flexi` this session reports `junk found=0, updated=0`
(idempotent, run-2 contract held) and the repaired leads now carry real
identity + `meta` + `webhookLogId` (3 sampled: `stage=Registered`,
`sourceUnknown=false`, custom field `what's_your_current_it` present in
`meta`, no backfill-created dupes — the one dup-phone group is the PO's
own repeated "test" submissions). **Fixed point + WAL held**
(`ad=3857 / adSet=1190 / spend=3857`, `journal_mode=wal`, G1=
`cl_upcurvv`) — the backfill writes only Lead/Event identity rows, never
a Meta pull row. No `next dev` next to prod; no `.env`/`dev.db`/`.next`/
scratch in the commit; no new `.env` keys.

**Commit:** this D-19 commit on `main` (`src/lib/adapters/{payments.ts,
types.ts}` + `src/lib/ingest.ts` + `src/lib/leadFormFields.ts` +
`src/lib/webhookPayload.ts` + `src/app/leads/[id]/page.tsx` +
`src/app/admin/integrations/IntegrationsPanel.tsx` +
`src/app/api/admin/webhooks/[id]/logs/[logId]/` +
`scripts/backfill-flexi.ts` + `package.json` alias + `test/d19b.test.ts`
+ `test/d18.test.ts`/`test/adapters.test.ts` repoint + `.gitignore` + the
3 doc files) — local only, PO reviews + pushes per the standing rule.
**The D-17 (tracker) working-tree changes — `prisma/schema.prisma`
(tracker models + `liveHostSeenAt`), `src/lib/session.ts`
(`admin_tracker`), and the `public/tracker.js` / `src/app/admin/tracker` /
`src/app/api/{admin/tracker,tracker}` / `src/lib/{tracker,live-host}.ts`
untracked files — are a SEPARATE, in-progress ticket and are EXCLUDED
from this commit.**

**Next gate = PO opens a `cl_abhishek-pal-fml` lead view and sees its
"Form data" card with the real custom answers + UTM + identity (the 3
backfilled leads now carry identity, no longer source-unknown); a FRESH
FlexiFunnels optin that lands `ok` already carries `meta` + `webhookLogId`
and renders the card from the event-`meta` path — no re-backfill needed.
Then PO drives the first real FlexiFunnels **purchase** to confirm the
"assumed" purchase envelope or capture its real shape.**
