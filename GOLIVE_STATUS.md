# GO-LIVE STATUS — Xacqora Track

Single source of truth for "what is real vs. dummy". A path is **LIVE** only
when a real-data verification has been shown (commit SHA + output, dated).
Until then it is **MOCK** (seed/simulate/fake) or **BLOCKED: needs X**.

Last updated: G1 LIVE · G2 SKIPPED-DEFERRED (PO decision 2026-10-30; gate order now G3→G4→G5→G6→G7→G8→G9→G10→G11) · public tunnel verified 2026-10-30 · owner: lead engineer

## Data stores

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Database | `prisma/dev.db` (SQLite) | Seed: 12 leads, 26 events, 120 spend rows | Postgres Mumbai (Supabase/Neon ap-south) + data copy | **MOCK** | G10 |
| Seed dataset | `src/lib/seed.ts` | Fake names/phones/payments | Real pilot data via webhooks + import | MOCK | — |

## Meta (spec §3, §5.2, §5.7, §5.8)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Ads pull (spend/entities) | `src/lib/meta/pull.ts` | **VERIFIED LIVE** 2026-10-29: real pull on act_…2164 ("Upcurvv-FML", INR) → 39 spend rows, real campaign/adset/ad names; 3-ad spot-check vs fresh live reads **0.00% each**, account total ₹51,480.77 **exact** (PASS GATE ≤1% cleared). Key findings baked into code: ad accounts need the `act_` prefix (`normalizeAdAccountRef`); this account's insights `time_range` param 400s, so the pull uses the no-range 30-day rollup; per-ad `/ads` objects are the spend units; `time_range`/`link_clicks`/`leads` are not valid here → documented proxies | Live pull via `pnpm pull:once` + scheduler + `POST /api/meta/pull` | **LIVE** | G1 evidence below: 39 rows, 0.00% Δ, seed accounts 403-isolated correctly |
| FX rate (USD→INR) | `src/lib/fx-store.ts` + `FxRate` table | **Stored daily rate, live-fetched-once + persisted** (spec 5.7: no report-time re-convert); `resolveDayRates` feeds every pull; 5 tests | Live rate verified | **LIVE** | `open.er-api.com` USD→INR **95.29615** fetched 2026-10-29 (real, no key) — recorded in G1 evidence |
| Pull scheduling | `src/jobs/pull-scheduler.ts` + `POST /api/jobs/pull` | Nightly 02:00 + 07/10/13/16/19/22, pure `cadenceForHour` (tested); resident loop `pnpm jobs:pull` + durable cron trigger with `CRON_PULL_SECRET`; idempotent upserts; **live firing verified** — `pnpm pull:once` ran the real pull end-to-end (39 rows). Note: Meta insights on this account only expose the 30-day rollup, so both slots pull the same rollup (documented in scheduler) | Platform cron in prod (Vercel/host) | **LIVE** (firing verified once manually; durable cron not yet wired to a platform timer) | G1 — `pull:once` real pass, cadence tests green |
| Instant Forms | `adapters/meta.ts` + `api/webhooks/[platform]` | Adapter + hub-challenge handshake implemented; not subscribed to any real Page | SKIPPED-DEFERRED. Product-owner decision 2026-10-30: Meta Instant Forms deferred. Code dormant, not on go-live path. Re-add its pass-gate only when G2 is scheduled. (The `/act_…/leadgen_leads` 2500 seen during probing is EXPECTED — LeadGen hangs off a Page, not an ad account; no Page is wired. Existing `meta_form_lead` adapter + its tests are left dormant and green, untouched.) | — | **SKIPPED-DEFERRED** | G2 deferred (PO decision 2026-10-30) |
| CAPI send | `src/lib/meta/capi.ts` | Simulate mode: no token ⇒ marks sent locally | Real Conversions API POST + EMQ readout | **BLOCKED: needs META_ACCESS_TOKEN + per-client pixel mapping** | G8 |

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
| Public URL | `https://competitive-gilbert-observation-hospitals.trycloudflare.com` → `http://localhost:3100` | **LIVE** — verified end-to-end 2026-10-30 |
| Tunnel | cloudflared quick tunnel (user-run, no account) | Valid only while the process + the :3100 app run; **not** the G10 Vercel target |

End-to-end verification through the public URL (2026-10-30, UTC):

- `GET /` → **200**; `GET /api/session` → **200** (real session: owner `arpit@…`, clients `cl_fitness` + `cl_iitprep`); `GET /xt.js` → **200**, 5,071 B served.
- `POST /api/ingest` (xt.js `ad_click` touchpoint, `cl_fitness`, with `ad_id`/`adset_id`/`campaign_id` + UTM) → **accepted**, persisted to DB: a `Touchpoint` row with `adId=12025344100000001`, `utmSource=facebook`, `visitorId` set, no lead (anonymous ad click). `events:0` is expected — that counter counts **lead-bearing** events; an ad click with no phone/email attaches to a visitor, not a lead.
- Meta `hub.challenge` handshake `GET /api/webhooks/meta` → **200, exact challenge echo** with the stored `.env` verify token; **403** on a wrong token (route reachable + gate works through the tunnel).

This URL is the host for **G3** (paste `xt.js` + `API_BASE`) and the inbound base for **G4** payment/gateway webhooks. It is a **temporary** dev endpoint: G10 replaces it with Vercel + a stable domain, and both must be re-pointed then.

## Webhooks / integrations (spec §6)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Public tunnel for webhooks/ingest | cloudflared quick tunnel | Live, verified end-to-end 2026-10-30 (see "Public tunnel" above) | Stable base for G3 `xt.js` + G4 gateway webhooks; retired at G10 | **LIVE (temporary)** | Public tunnel block |
| xt.js on landing pages | `xt/` → `public/xt.js` (4.95 KB) | Built + served at `/xt.js` (5,071 B) via tunnel; **not deployed to any live page** | Pasted on all pilot landing pages; ≥95% of leads carry ad_id/UTM | **MOCK: not deployed** | G3 |
| Meta dynamic URL params | — (Ads Manager side) | Unaudited | `{{campaign.id}}/{{adset.id}}/{{ad.id}}` on every ad URL; app audit screen | **MOCK** | G3 |
| Razorpay / Cashfree / Cosmofeed | `adapters/payments.ts` + `api/webhooks` | HMAC verify implemented; secrets are seed fakes (`whsec_*`) | Real gateway webhooks + real secrets + ₹1 test payments + 3× replay dedup proof | **BLOCKED: needs gateway secrets + test payments** | G4 |
| TagMango / FlexiFunnels | `adapters/payments.ts` | Implemented | Real webhooks | **BLOCKED: needs platform URLs + secrets** | G4 |
| Aevent / Zoom | `adapters/engagements.ts` | Implemented | Real webhooks + test attendee (register/attend/replay) | **BLOCKED: needs platform configs + test attendee** | G5 |
| Calendly / Pabbly / WhatsApp | `adapters/engagements.ts` | Implemented | Real webhooks + real booking + WhatsApp round-trip | **BLOCKED: needs accounts + test actions** | G6 |
| Sheets/CSV backfill | `api/import` + `src/lib/csv.ts` | Implemented (dry-run preview not yet built) | Real old-client sheet import with mapping + commit-after-approve | **BLOCKED: needs a real sheet** | G7 |

## Reconciliation & reporting (spec §7)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Revenue vs gateways ≤2% | `reports.ts` | Runs on seed numbers | Pilot-week reconciliation vs gateway dashboards | **BLOCKED: needs G4 live** | G9 |
| Spend vs Ads Manager ≤1% | `reports.ts` | G1 live pull now populates real spend (39 rows, ₹51,480.77); account total vs live = 0.00% | Full pilot-week reconciliation vs Ads Manager dashboards | **LIVE (single-account)** — 3-ad + account-total check cleared 0.00%; G9 pilot-week table still pending | G1 cleared the gate for this account; G9 formalizes across a week |
| Meta vs Track conversions | `reports.ts` | Seed `metaConversions` | Real Meta-reported vs our counted | **BLOCKED: needs G1+G8 live** | G9 |
| Weekly Monday 9AM IST summary | `reports.weeklySummary()` | Function exists; **no scheduler, no PDF** | Durable cron → portal + PDF | **MOCK** | G9/G11 |
| CSV/Excel export | `reports.ts` | Working | — | LIVE (code-complete, unit-tested) | G0 commit |

> **G2-deferred consequence (PO decision 2026-10-30, recorded on G9 too):**
> "Lead source mix" will show **Instant Form = 0%** — expected, not a bug.
> CAPI **Lead** events come from `form_submit` (xt.js) and CSV imports, not
> `meta_form_lead`. G2's gate ("100% of Instant Form leads land <1 min with
> ad_id") is **dropped** from the G9 checklist; G8 dedup rules unchanged.

## Platform / security (spec §8, §10)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Auth | `src/lib/session.ts` | `DEMO_USER` env + `xacqora_user` cookie; personas are seed users | Supabase/Clerk Auth + 2FA on all FL users | **MOCK** | G10/G11 |
| RLS | Postgres (not SQLite) | Query-layer `clientId` scoping only | DB-level RLS policies + negative test | **MOCK (no DB support yet)** | G10 |
| Hosting | Next.js local (`next start`) | Local dev server | Vercel + Mumbai Postgres; tunnel retired | **MOCK** | G10 |
| Backups / restore test | — | None | Daily backup + monthly real restore | **MOCK** | G10 |
| Error tracking (Sentry) | — | Not wired | DSN + webhooks alerted on failure | **MOCK** | G10 |
| Secrets at rest | `.env` | Plaintext env, gitignored | Encrypted store (Supabase secrets / KMS) | **MOCK** | G10 |
| Audit log | `security.ts` + `audit` screen | Working, seed rows | Live actions | LIVE (code-complete) | G0 commit |
| Phone/email hashing (SHA-256) | `src/lib/hash.ts` | Working, unit-tested | — | LIVE (code-complete) | G0 commit |
| Ingest rate limit | `security.ts` | Working (in-memory) | Redis-backed for multi-node | LIVE (code-complete) | G0 commit |
| Webhook signature verify | `adapters/*` + `ingest.ts` | Razorpay/Cashfree HMAC + shared-secret verify; unit-tested | Real keys | LIVE (code-complete, keys pending G4) | G0 commit |

Legend: **LIVE** = real-data verified · **MOCK** = code-complete but running on
seed/simulate/fake · **BLOCKED: needs X** = code exists, live path waits on X.
