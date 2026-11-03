# XACQORA TRACK — NEW TICKET: Dashboard V2 (all-accounts default, full Meta data, 10-min auto-refresh)

> Product-owner decisions, 2026-11-02:
> 1. Every filter/screen defaults to **ALL clients / ALL ad accounts** (aggregate view);
>    per-client and per-account drill-down stays available.
> 2. The dashboard must surface **every Meta-relevant figure the app tracks** — not a
>    sparse empty shell. Real numbers only; a 0 with an honest "AWAITING LIVE TRAFFIC
>    (G3/G4)" label is correct; fake numbers are forbidden.
> 3. Data **auto-updates every 10 minutes** (scheduler pull), and the dashboard shows
>    a "data as of" stamp + auto-refreshes itself without manual reloads.
> 4. Fix the FX gap: the AED account currently stores `fxRate=0` (live FX fetch was
>    blocked in the sandbox; documented, not faked). Make FX real on this machine.

## Preconditions (do NOT start until true)
- The 7-account multi-onboarding ticket is committed ([REVIEW] in place), spot-check
  variance table delivered, `git status` clean. If not, finish that first and say so.

## 1. Default "All" semantics (record as D-xx)
- `client` filter default = **All clients** (aggregates across all 7 accounts' clients).
- `adAccount` filter default = **All ad accounts**.
- Both selectors stay DB-driven (`/api/session`); adding account #8 in `.env` or via
  the scheduler must make it appear with zero UI changes.
- Per-account drill-down: account cards are clickable → pre-filtered views of
  leads/reports (existing behavior, keep).
- Every aggregate KPI = sum over accounts, per-currency + INR-normalized (once §4 lands).

## 2. Dashboard data — the full Meta-relevant set (spec §5.4/§7; all REAL from G1 pulls)
KPI cards (top row): Total ad spend (billing-currency per account + total INR),
Leads, Registered, Attended, Calls booked, Revenue (net of refunds),
Cost/sale, ROAS. Leads-family = 0 + "AWAITING LIVE TRAFFIC (G3/G4)" label while G3/G4
are not live — the label changes to live counts automatically once data exists.
Account cards: name, metaId, currency, status, 30d spend, campaigns/ad sets/ads
counts, **last pulled (HH:MM IST)**, per-account spot-check Δ (from the G1-rule
table) — 7 cards by default, grid.
Charts: daily ad spend (note the G1 limitation: per-day only where available, else
30-day rollup — label it on the chart), lead source mix, top campaigns by spend.
Tables: Top ads by spend (thumbnail + campaign/adset names + spend/sales/ROAS per
attribution model), CAPI send status summary (events by type + match-quality avg —
0 events = honest "0 queued" state, not hidden).
Timestamps: "Data as of <last successful pull, IST>" + 10-min refresh countdown.

## 3. 10-minute auto-update (scheduler + UI)
- Scheduler: add a **10-minute fast tick** (during the day, 00:00–23:59 IST) that
  runs the 1-day insights pull for all accessible accounts, idempotent upsert.
  Nightly 30-day pull stays. 3-hourly tick: keep or fold into the 10-min tick
  (your call, record it). **Single-writer discipline (lesson from the idempotency
  pass): one pull process at a time; a running tick must skip, never parallelize —
  lock test included.**
- FX fetch runs inside the same tick (§4).
- UI: dashboard client polls the local report endpoints every 60 s (cheap,
  no Meta calls from the browser — Meta calls only via scheduler/`Pull from Meta`
  button); shows "Data as of HH:MM IST · next update in N min". No page reload.

## 4. FX fix (the AED gap)
- Multi-source FX fetch with fallback order: `open.er-api.com` →
  `frankfurter.dev` → `exchangerate.host`; store in FxRate (date, base, target, rate,
  source) once per day per pair; INR accounts = 1:1 identity (existing).
- After a successful fetch: **backfill** `inrSpend` for stored native-only spend rows
  (the AED rows with inrSpend=0) for the stored date range — one-time + daily.
- Tests: mock FX source (unit), backfill idempotency (running twice changes nothing).
- LIVE condition: run on THIS machine; show me the fetched AED→INR rate + a backfilled
  AED account total in INR. If all three sources are unreachable from the machine,
  mark `FX: BLOCKED: network` with the three exact error strings — never hardcode a
  fake rate.

## 5. Verification before commit
- Screenshot-grade evidence: dashboard with All-default + all 7 account cards +
  "Data as of" stamp; the 10-min tick log lines (2 consecutive ticks, idempotent);
  FX rate fetched + backfilled totals; pnpm test + pnpm build green.
- `GOLIVE_STATUS.md` row "Dashboard V2 + 10-min autopull + FX" → DONE (or partial
  with exact blockers); `DECISIONS.md` D-xx for defaults + tick design.
- Commit: `[REVIEW]` (money display + scheduler paths).

## Rules
- No fake data, no seed resurrection (D-02 stands: seed = tenancy only).
- Nothing in this ticket may delete real G1/G1-multi pull rows.
- Ends with: "Next gate = G4 webhooks per client" + current per-client webhook
  URLs (dev = current trycloudflare tunnel; G10 swaps the host).
