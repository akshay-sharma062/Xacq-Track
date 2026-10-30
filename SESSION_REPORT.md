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

## What stays BLOCKED (unchanged)
- G2 Instant Forms (needs Page ID + webhook subscription + public URL),
  G4–G7 webhooks (secrets/actions), G8 CAPI EMQ gate, G10 platform.
- Weekly 9AM summary cron + PDF (G9/G11) — pull cadence cron itself is wired,
  just not attached to a platform timer yet.

## Next handoff card
```
STEP G2: Meta Instant Forms → real leads (spec §5.2)
YOU PROVIDE:
  1) The Page ID used for Instant Forms — Meta Business Suite → Pages →
     (click your Page) → copy the Page ID. (You have 25 ad accounts in
     Business; the Page lives in one of them.)
  2) Meta Business Suite → Webhooks → Instant Forms: create/subscribe a
     webhook to https://<your public URL>/api/webhooks/meta?client=<clientId>
     with your verify token (already in .env as META_LEADGEN_WEBHOOK_VERIFY_TOKEN).
     For dev we need a public URL: say "run cloudflared" and I'll start the
     tunnel + capture the URL for you to paste into Meta.
  3) Fill one test Instant Form on a real ad (so it carries ad_id).
CLAUDE DOES: verify the hub.challenge handshake live against the tunnel URL,
  confirm a real lead row appears <1 min with ad_id non-null + your earlier
  page-views attached (visit a pilot landing page first), per-form field
  mapping, dedup by phone. Commit [REVIEW].
PASS GATE: "100% of pilot Instant Form leads land within 1 minute with ad_id".
BLOCKED-IF: no public URL → I prepare cloudflared; no Page ID → sub-paths stay
  BLOCKED: needs Page ID; nothing else waits.
```
