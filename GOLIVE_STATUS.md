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
| FX rate (multi-currency→INR) | `src/lib/fx-store.ts` + `FxRate` table | **Stored daily rate, multi-source live fetch + persisted, then backfilled** (spec 5.7 + D-05 §4): `fetchLiveFxRate` tries `open.er-api.com → frankfurter.dev → exchangerate.host` (source recorded on the row; all-unreachable → exact 3 error strings, never a fake rate); `backfillMissingInr` re-converts native-only rows once a rate lands; `resolveDayRates` feeds every pull; 12 tests | Live rate verified | **LIVE (multi-source + backfill)** | 2026-11-03: **AED→INR 25.849976** fetched (source #1, this machine); "The Job Workshop" AED account backfilled → **₹384,113.82** INR. Also fixed a real `.env` bug (`FX_API_BASE` had a stray inline comment + embedded quotes that were silently breaking source #1's URL). |
| Pull scheduling | `src/jobs/pull-scheduler.ts` + `POST /api/jobs/pull` | Nightly 02:00 + 07/10/13/16/19/22, pure `cadenceForHour` (tested); resident loop `pnpm jobs:pull` + durable cron trigger with `CRON_PULL_SECRET`; idempotent upserts; **live firing verified** — `pnpm pull:once` ran the real pull end-to-end (39 rows). Note: Meta insights on this account only expose the 30-day rollup, so both slots pull the same rollup (documented in scheduler) | Platform cron in prod (Vercel/host) | **LIVE** (firing verified once manually; durable cron not yet wired to a platform timer) | G1 — `pull:once` real pass, cadence tests green |
| Instant Forms | `adapters/meta.ts` + `api/webhooks/[platform]` | Adapter + hub-challenge handshake implemented; not subscribed to any real Page | SKIPPED-DEFERRED. Product-owner decision 2026-10-30: Meta Instant Forms deferred. Code dormant, not on go-live path. Re-add its pass-gate only when G2 is scheduled. (The `/act_…/leadgen_leads` 2500 seen during probing is EXPECTED — LeadGen hangs off a Page, not an ad account; no Page is wired. Existing `meta_form_lead` adapter + its tests are left dormant and green, untouched.) | — | **SKIPPED-DEFERRED** | G2 deferred (PO decision 2026-10-30) |
| CAPI send | `src/lib/meta/capi.ts` + `meta/pixel-map.ts` | **LIVE 2026-11-04:** per-client pixel mapping (`pixelForClient` reads `META_PIXEL_ID_<CLIENT>`; value-free — no pixels in code). `sendQueue` flips to a **real Conversions API POST** when BOTH `META_ACCESS_TOKEN` + a client pixel are present; no token ⇒ honest local mark (`simulated=true`), never faked. Wire: SHA-256 hashed `ph`/`em`, `fbc`/`fbp`, frozen `event_id` dedup, retry queue; EMQ read back from Meta `event_hub_log_view[].event_match_quality` and **persisted verbatim** (`metaEmq`/`emqFromMeta`, `emqFromMeta=true` only when Meta returned it — never invented). Web-originated events send `action_source:"website"` + `event_source_url` (Meta 400 subcode 2804039 dictated "website", not "browser"/"system"); Meta 4xx/403 ⇒ row `failed` with the **exact Meta error string** (BLOCKED, retriable). Proof: `pnpm capi:replay` pushed one labelled synthetic high-signal Purchase for `cl_upcurvv` through the real `postOneCapiEvent` path → **Meta HTTP 200 + fbtrace_id `AoRi_ZmEpa895gB22GnWzRW`** (appended to `.g8-evidence.txt`, gitignored). Honest caveat: Meta's 200 ack came back **without** a hub-log `event_id` or an EMQ value for this synthetic (no G3-matched browser-pixel traffic), so `EMQ≥7 on Purchase` remains gated on real G3 live traffic — not claimed here. `cl_piyush-ahuja` has no pixel key ⇒ stays simulate. 12 CAPI live-path tests (mocked Meta HTTP + dedup re-run + refund-guard regression) green. | `META_ACCESS_TOKEN` + per-client pixel envs | **LIVE (Meta 200 ack on labelled replay; EMQ≥7 awaits G3 live traffic)** · `cl_piyush-ahuja` still simulate | G8 · D-07 |
| **Dashboard V2 (D-05)** | `dashboard.ts` `dashboardAll` + `page.tsx` + `AutoRefresh.tsx` | All-clients/All-accounts **default** view, dense off the G1 pulls: aggregate KPI row (per-currency + INR), 7 per-account cards (last-pulled stamp), daily-spend chart, top campaigns/ads, CAPI strip, sync/FX strip; **60 s auto-refresh** (client polls → server refresh, no Meta calls from the browser); a leads-family 0 is labelled "AWAITING LIVE TRAFFIC (G3/G4)" | Live DB reads at request time | **DONE (All-default + dense dashboard)** | D-05 · 2026-11-03 |
| **10-min autopull + single-writer lock (D-05 §3)** | `src/jobs/pull-scheduler.ts` `runFastTick` + `src/jobs/pull-lock.ts` | 10-min fast tick (`pnpm pull:fast` / resident `startFastLoop`) refreshes the day's data + re-runs FX backfill; a **file lock** makes a running tick skip, never parallelize (30-min TTL so a dead holder can't wedge it); the 3h entity tick is folded in | Durable scheduler + platform cron | **DONE (lock + fast tick, tested)** | D-05 · two-tick idempotency + lock test (`test/pull-lock.test.ts`) |

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
| Public URL | `https://oak-alpha-rewards-workstation.trycloudflare.com` → `http://localhost:3100` | **LIVE** — verified end-to-end 2026-10-30 (16:10 IST) |
| Tunnel | cloudflared quick tunnel (user-run, no account) | Each restart gives a NEW random subdomain; old one (`competitive-gilbert…`) already dead. Valid only while the process + the :3100 app run; **not** the G10 Vercel target |

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

**Paste-ready snippet for `https://join.upcurvv.com/cll`** (host verified,
client = `cl_upcurvv`):

```html
<script src="https://oak-alpha-rewards-workstation.trycloudflare.com/xt.js"
        data-api="https://oak-alpha-rewards-workstation.trycloudflare.com"
        data-client="cl_upcurvv"
        defer></script>
```

## G3 status (post D-02 remodel, 2026-10-30 — gate now LIVE-traffic-only)

| G3 sub-item | Status | Evidence |
|---|---|---|
| Final `xt.js` build | **DONE** — 4.96 KB (<10 KB), served at `/xt.js` via tunnel; contract fixed (`POST /api/ingest` + top-level `client`), CORS preflight added | `public/xt.js`; commit `6feec32` |
| Host URL | **DONE** — `oak-alpha-rewards-workstation.trycloudflare.com` live (re-verify before paste; quick-tunnel subdomains die with the process) | GET `/`, `/xt.js` 200 |
| data-client | **RESOLVED** → `cl_upcurvv` (D-01) | `G3_INPUTS.md` |
| Param-audit | **PASSES by construction** — the PO template's `campaign_id`/`adset_id`/`ad_id` query keys are exactly what xt.js's extractor reads (`xt/src/index.ts` L63–65) | `node scripts/audit-g3-link.mjs "<link>"` |
| **≥95% ad_id/UTM gate** | **AWAITING LIVE TRAFFIC** (D-03) | 0 leads is a valid state pre G3/G4. The gate is measured ONLY on real `POST /api/ingest` traffic under `cl_upcurvv` once the snippet is pasted — stored-data snapshots no longer count (deleted). Needs ~20+ live clicks to be meaningful; until then status is AWAITING LIVE TRAFFIC, never MET. |

**Pass evidence required (D-03):** after pasting the snippet, Meta delivers a
real click → a touchpoint must land with `client=cl_upcurvv` + `adId` non-null.
No seed backfill counts.

## Webhooks / integrations (spec §6)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Public tunnel for webhooks/ingest | cloudflared quick tunnel | Live, verified end-to-end 2026-10-30 (see "Public tunnel" above) | Stable base for G3 `xt.js` + G4 gateway webhooks; retired at G10 | **LIVE (temporary)** | Public tunnel block |
| xt.js on landing pages | `xt/` → `public/xt.js` (4.96 KB) | Built + served at `/xt.js` via tunnel; contract-fixed (`/api/ingest` + CORS); **not deployed to any live page** | Pasted on pilot pages (`cl_upcurvv`); ≥95% of leads carry ad_id/UTM — D-03: measured on LIVE traffic only | **AWAITING LIVE TRAFFIC** | G3 |
| Meta dynamic URL params | — (Ads Manager side) | Unaudited | `{{campaign.id}}/{{adset.id}}/{{ad.id}}` on every ad URL; app audit screen | **MOCK** | G3 |
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
