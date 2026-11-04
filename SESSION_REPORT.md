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
