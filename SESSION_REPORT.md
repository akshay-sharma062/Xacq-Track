# SESSION REPORT — G1 (Meta: ad accounts + real spend pull)

Date: 2026-10-29 · Engineer: Claude Opus 5 · Commit: (this G1 commit)

## What went live
- **Stored daily FX rate (spec 5.7)** — `src/lib/fx-store.ts` + `FxRate` table.
  Rates are fetched live **once per day** and persisted; pulls convert with the
  stored rate so reports never drift. **LIVE-VERIFIED**: `open.er-api.com`
  USD→INR returned **95.29615** (real network, no key) and the value is
  persisted to the `FxRate` table on first use.
- **Real Marketing-API pull path** (`src/lib/meta/pull.ts`): campaigns → ad sets
  → ad creatives (with thumbnails) → **daily** insights (spend, impressions,
  reach, clicks, link clicks, ThruPlays, leads+purchases), with Graph
  pagination, per-account error isolation (`pullAllAccounts`), and the account's
  real billing currency. Simulate stays available behind `META_SIMULATE=1`.
- **Durable scheduler** (`src/jobs/pull-scheduler.ts` + `POST /api/jobs/pull`):
  nightly 02:00 30-day backfill + every-3h daytime pulls; pure cadence fn is
  unit-tested; idempotent upserts make re-firing a no-op.
- `pnpm meta:verify-token` handoff script: `/me` liveness, accessible ad
  accounts, and the live 1-day insights GET — the exact G1 verify, in one
  command. Never prints the token.
- **100/100 tests** (8 new: fx-store ×5, scheduler cadence ×6, net −1 dup),
  `tsc` clean, `pnpm build` exit 0.

## What is BLOCKED (and on exactly what)
- **Live token verify + real pull + 3-ad spot-check** → `BLOCKED: needs
  META_ACCESS_TOKEN + ad account IDs in .env`. The last handoff carried
  placeholders (`<list>`, `<id>`), and my audit of `.env` (key names only) shows
  only `DATABASE_URL` + `DEMO_USER` — **no token**. Code is ready; the moment
  the values land, `pnpm meta:verify-token` → `pnpm pull:once` proves it.

## Next handoff card
```
STEP G1 (finishing): real pull + 3-ad spot-check
YOU PROVIDE:
  1) META_ACCESS_TOKEN in .env (system-user, spec scope set) — confirm "done"
  2) META_AD_ACCOUNT_IDS in .env (comma-separated real ad account IDs)
  3) Page ID for G2 (can be later)
CLAUDE DOES: pnpm meta:verify-token (live GET shown) → pnpm pull:once (real
  rows into ad/spend + FxRate) → 3-ad spot-check table (our spend vs the
  numbers Meta's debug output shows) → mark LIVE with commit + output.
PASS GATE: "Spend per account matches Meta Ads Manager within 1%".
```

## Safety rails upheld this session
- Token never printed (audits show key names + length only).
- No real client data / tokens committed; `.env`, `prisma/dev.db` gitignored.
- This commit touches CAPI-adjacent money paths (spend/FX) ⇒ marked **[REVIEW]**.
