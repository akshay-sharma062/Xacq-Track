# GO-LIVE STATUS — Xacqora Track

Single source of truth for "what is real vs. dummy". A path is **LIVE** only
when a real-data verification has been shown (commit SHA + output, dated).
Until then it is **MOCK** (seed/simulate/fake) or **BLOCKED: needs X**.

Last updated: G1 complete (token-dependent sub-paths BLOCKED) · owner: lead engineer

## Data stores

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Database | `prisma/dev.db` (SQLite) | Seed: 12 leads, 26 events, 120 spend rows | Postgres Mumbai (Supabase/Neon ap-south) + data copy | **MOCK** | G10 |
| Seed dataset | `src/lib/seed.ts` | Fake names/phones/payments | Real pilot data via webhooks + import | MOCK | — |

## Meta (spec §3, §5.2, §5.7, §5.8)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| Ads pull (spend/entities) | `src/lib/meta/pull.ts` | Real path DONE: campaigns→adsets→creatives→**daily** insights, pagination, thumbnails, per-account error isolation, stored billing currency; `simulatePull` behind `META_SIMULATE` flag; 7+ new tests green | Live pull vs token + 3-ad spot-check ≤1% | **BLOCKED: needs `META_ACCESS_TOKEN` + ad account IDs in .env** (code ready) | G1 — typecheck+100 tests+build clean; verify script `pnpm meta:verify-token` staged |
| FX rate (USD→INR) | `src/lib/fx-store.ts` + `FxRate` table | **Stored daily rate, live-fetched-once + persisted** (spec 5.7: no report-time re-convert); `resolveDayRates` feeds every pull; 5 tests | Live rate verified | **LIVE** | `open.er-api.com` USD→INR **95.29615** fetched 2026-10-29 (real, no key) — recorded in G1 evidence |
| Pull scheduling | `src/jobs/pull-scheduler.ts` + `POST /api/jobs/pull` | Nightly 02:00 (30d backfill) + 07/10/13/16/19/22 (1d), pure `cadenceForHour` (tested); resident loop `pnpm jobs:pull` + durable cron trigger with `CRON_PULL_SECRET`; idempotent upserts | Platform cron in prod (Vercel/host) | **MOCK** (code-complete, tested; live firing blocked on token) | G1 — 6 cadence tests green |
| Instant Forms | `adapters/meta.ts` + `api/webhooks/[platform]` | Adapter + hub-challenge handshake implemented; not subscribed to any real Page | Real leadgen webhook on a public URL | **BLOCKED: needs Page ID + webhook subscription + public URL** | G2 |
| CAPI send | `src/lib/meta/capi.ts` | Simulate mode: no token ⇒ marks sent locally | Real Conversions API POST + EMQ readout | **BLOCKED: needs META_ACCESS_TOKEN + per-client pixel mapping** | G8 |

### G1 evidence (2026-10-29)
- `tsc --noEmit` clean · `vitest` **100/100** (8 new: 5 fx-store + 6 cadence − 1 dedup) · `pnpm build` exit 0.
- FX live path: `curl https://open.er-api.com/v6/latest/USD → rates.INR = 95.29615` (real network, no key).
- Token audit: `.env` holds only `DATABASE_URL` + `DEMO_USER`; `META_ACCESS_TOKEN` **absent**, and the handoff carried placeholders (`<list>` / `<id>`), so the live pull + 3-ad spot-check remain BLOCKED until the real values land. Verify when they do: `pnpm meta:verify-token`, then `pnpm pull:once`.

## Webhooks / integrations (spec §6)

| Item | File | Current | Live path | Status | Evidence |
|---|---|---|---|---|---|
| xt.js on landing pages | `xt/` → `public/xt.js` (4.95 KB) | Built + served at `/xt.js`; queue/retry; **not deployed to any live page** | Pasted on all pilot landing pages; ≥95% of leads carry ad_id/UTM | **MOCK: not deployed** | G3 |
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
| Spend vs Ads Manager ≤1% | `reports.ts` | Runs on seed numbers | Pilot-week reconciliation vs Ads Manager | **BLOCKED: needs G1 live** | G9 |
| Meta vs Track conversions | `reports.ts` | Seed `metaConversions` | Real Meta-reported vs our counted | **BLOCKED: needs G1+G8 live** | G9 |
| Weekly Monday 9AM IST summary | `reports.weeklySummary()` | Function exists; **no scheduler, no PDF** | Durable cron → portal + PDF | **MOCK** | G9/G11 |
| CSV/Excel export | `reports.ts` | Working | — | LIVE (code-complete, unit-tested) | G0 commit |

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
