# XACQORA TRACK — NEW TICKET: All-Clients Default + Full Meta Dashboard + 10-min Auto-Update

> Product-owner decisions 2026-11-02:
> 1. **Default view = ALL clients / ALL ad accounts** (aggregated), not a single client.
> 2. The dashboard must carry **every Meta data block the app needs** — today it is mostly
>    empty; after this ticket it must be information-dense and live.
> 3. **Data auto-updates every 10 minutes** while the app runs (server-side pull cycle +
>    UI auto-refresh + honest "last updated" indicators).
>
> Record as D-xx in DECISIONS.md: "All-clients default view + 10-minute auto-update cycle
> + dense Meta dashboard (PO decision 2026-11-02)."
>
> PREREQUISITE: the multi-account ticket's idempotency writer must have FINISHED and its
> [REVIEW] commit landed before starting this ticket. Verify: `git log -1`, clean tree,
> all 7 accounts present in the AdAccount table (row counts from the committed evidence).

## 1. All-clients default (filter semantics)

- Topbar selectors: add **"All clients"** option and make it the DEFAULT; "All ad accounts"
  also default (both already exist as options — just flip the default).
- Aggregation semantics for the All view (DB queries, never hardcode):
  - KPI cards = SUM over all accounts/clients (multi-currency: show native-currency
    totals per currency group + INR-equivalent where rates exist; mark "INR-equiv
    pending" for accounts with missing FX rate — e.g. the AED account until backfill).
  - Per-client breakdown table (client, owner, #ad accounts, #campaigns/#ads,
    30d spend per currency, INR-equiv, leads/sales counts, last pull time).
- All spend-family reports + dashboard KPIs accept "All" (no client/adAccount param =
  all visible to the role). Per-client views still work unchanged.
- `?adAccount=` resolver: no param = ALL; known id = that account; unknown = 404-ish
  safe no-op to all (existing behavior) — keep.

## 2. The dense Meta dashboard (every block, from the spec §5.7/§5.8 data)

On the Dashboard + Meta pull & CAPI screens, render these blocks (All-view default):

**A. KPI row (aggregated, All view):** 30d spend (per currency + INR-equiv), total
impressions, reach, clicks, CTR, CPM, CPL, ThruPlays, active campaigns/ads/creatives
counts, leads / registered / attended / call-booked / paid / revenue / ROAS (last 7d
+ 30d toggle) — leads-side shows honest zeros + "awaiting G3/G4 live traffic" note.

**B. Per-ad-account table (all 7+):** account name + metaId, owner (displayOwnerName),
currency, account_status, 30d spend (native + INR-equiv or "backfill pending"),
campaigns / ad sets / ads counts, #spend rows, **last pull time**, pull status
(ok / error detail truncated), next scheduled pull.

**C. Daily spend chart:** 30-day series, All = stacked by account (or total toggle);
INR-equivalent when rates exist, native-currency series selectable for multi-currency.

**D. Top ads table:** top 20 ads by 7d spend: ad name, campaign, ad set, creative
thumbnail (G1 already stores them), spend, clicks, impressions, CTR, ThruPlays,
last-active date. Row click → drills into that ad's 30d sparkline + creative.

**E. CAPI pipeline block:** queued / sent / failed / skipped counters, avg Event
Match Quality, last-20 events table (event, value, match Q, status, when, dedup id),
per-client dataset/pixel mapping (from settings), the dedup + refund rules line
(already present). Honest zeros until G8 live (note text).

**F. Sync status strip:** last entity pull time, last insights (10-min) pull time,
scheduler state (running/paused/error), FX rate table (currency, rate, fetched-at,
missing→"backfill pending" badge), failed-account list (with Meta error snippet).

**G. Auto-refresh:** UI polls `/api/reports` (All view) every 60 s; shows
"Updated X min ago · next pull in Y min"; manual "Pull from Meta" button stays.

Rules: every number rendered = live DB query at request time (no seed, no hardcode);
zero-states are honest with a one-line "why" note; thumbnails reuse G1's creative
artwork URLs (Meta CDN links, stored).

## 3. The 10-minute auto-update cycle (server-side scheduler)

- New job cadence (extend the existing durable scheduler, spec §5.7):
  - **every 10 min** (`pull:insights10m`): for every ACCESSIBLE account, fetch
    TODAY's + YESTERDAY's daily insights only, upsert into Spend. **Skip days older
    than 2** (finalized; refetch only missing rows) — keeps the API cost/rate sane.
  - **every 3 h** (existing): full entity refresh (campaigns/ad sets/ads/creatives).
  - **02:00 daily** (existing): 30-day rollup + FX fetch.
- FX retry: every 15 min, re-attempt any missing/zero FX rate (open.er-api; this
  clears the AED "INR backfill pending" rows as soon as network allows — record it
  when it happens).
- Rate-limit discipline: ONE shared system-user token → serialize pulls
  (concurrency 1 per token), batch insights `limit=100`, on Meta 17/4 rate errors:
  exponential backoff (30s→2m→10m), never hammer; one account's failure must not
  stop the others (per-account isolation, already designed — keep + test).
- Failure UX: account row shows "last good pull HH:MM + error" (truncated Meta code),
  cycle continues; scheduler state visible in block F.
- Command: `pnpm pull:insights10m` (manual trigger) + it auto-runs while the app
  process is up (durable scheduler). Document in docs/modules.md + TESTING.md.

## 4. Verification (show before commit)

- Default load of `/` = All view: KPI row shows cross-account totals; per-account
  table lists ALL 7 accounts with their real committed numbers (match G1/multi-pull
  evidence: e.g. Upcurvv-FML ≈ ₹64.4k class 30d, The Job Workshop = AED + "INR
  backfill pending" badge until FX lands).
- Run `pnpm pull:insights10m` manually twice: first fetches today's rows, second is a
  no-op except today's live-changing rows (row counts stable; "last pulled" timestamp
  advances; prove with a before/after snapshot).
- UI "Updated X min ago" counts down and auto-repolls (verify with two loads 65s
  apart).
- One simulated failure: point one account's pull at a broken metaId for the test →
  error shows in block F + other 6 still update (test, then restore).
- `pnpm test` (new tests: aggregation queries, 10-min job skip-finalized-days logic,
  FX backfill retry, per-account isolation) + `pnpm build` green; clean tree; no
  secrets in commit. `[REVIEW]` (spend/report paths).

## 5. Docs + end-state

- GOLIVE_STATUS.md: rows "All-clients default view" + "Dense Meta dashboard" +
  "10-min auto-update cycle" → DONE (commit SHA + snapshot evidence); FX-backfill
  row stays PENDING until AED rate lands (note when it does).
- SESSION_REPORT.md: what's live now (data flowing every 10 min on its own), what's
  still manual (nothing for Meta data), next = G4 per-client webhook URL list
  (client → https://<current-tunnel>/api/webhooks/<platform>?client=<id> + secret
  placement in .env).

## 6. Rules (contract reminders)

- 0 hardcoded numbers; 0 seed data; honest zero-states with one-line "why".
- 10-min cycle = insights-only for today/yesterday — do NOT build a re-pull of the
  whole history every 10 min (that's the hourly/daily job's job).
- Never mark "live" on simulated data; the 10-min proof uses a real pull against Meta.
- End with the G4-ready list (per-client webhook URLs + which secrets go in .env).
