# XACQORA TRACK — NEW TICKET: Multi-Ad-Account Onboarding (7 accounts, fully automatic)

> Product-owner decision 2026-11-02: onboarding MORE Meta ad accounts must be
> ZERO-MANUAL: I give ad-account IDs, Claude Code pulls everything itself from the
> Meta Marketing API (name, currency, campaigns, ad sets, ads, creatives, daily
> spend) and creates the tenant structure automatically. Nothing typed into the UI.

## The accounts (7)

```
1377451727314532
4749960348632164   (already onboarded as the G1 LIVE account "Upcurvv-FML" → cl_upcurvv)
4683943305259169
500594992542527
1042839737275035
1626467978880942
935714081758825
```

`4749960348632164` is already LIVE from G1 (39 spend rows, cl_upcurvv) — for it,
this ticket must be idempotent (re-pull / upsert, never duplicate rows, never
overwrite the existing client mapping).

## What you do, per account (all from the API — NO manual data entry)

1. **Read identity via API first**: `GET /{adaccount}?fields=name,currency,account_status`
   using the G1 system-user token. This gives the real account name + currency for
   each of the 7 — print a 7-row table to me: `metaId | name | currency | status`.
   If any returns 401/403: mark it `BLOCKED: needs <permission>` in GOLIVE_STATUS.md
   with the EXACT error message + the permission name from Meta's error payload,
   and continue with the others. Never silently skip. (G1 precedent: two seed
   accounts failed 403 for missing ads_read — same isolation rule.)
2. **Create/reuse tenant rows automatically**:
   - For each successfully-read account: upsert `AdAccount` row
     (metaId with `act_` normalization, name, currency, displayOwnerName = account
     name, status).
   - **Client naming rule (per PO decision 10-30): client = named after the ad
     account owner.** Auto-create one client per account (id `cl_<slugified-
     account-name>`) when none exists yet; if the account already maps to a
     client (the G1 one → cl_upcurvv), keep it. Record this provisional 1:1
     mapping as D-xx in DECISIONS.md with the note: "accounts of one business
     can later be merged under one client via a documented merge — not done now".
     Do NOT ask me to pick clients — derive from the API names.
3. **Full entity pull**: run the G1 pull path (`pull.ts` real mode) for every
   accessible account: campaigns → ad sets → ads → creatives (with thumbnails)
   → daily insights (spend, impressions, reach, clicks, ThruPlays), same 30-day
   rollup behavior as G1 (documented time_range limitation stays). Upsert,
   idempotent, dedup by metaId.
4. **Scheduler**: confirm the durable scheduler now covers ALL accessible
   accounts (nightly 30d + 3-hourly 1d), and that a per-account failure in one
   account never aborts the others (per-account error isolation, already
   designed in G1 — verify with a test that simulates one 403 mid-batch).
5. **Reports/filters**: the `?adAccount=` filter + Topbar selector must now list
   all accessible accounts (DB-driven, from `/api/session` — no hardcoding).
   Dashboard shows per-account: spend total, campaigns, ads, leads (0 until G3/G4
   traffic — honest empty state).

## Verification (show me, before committing)

- The 7-row identity table from step 1 (names/currencies from the API, not guesses).
- Row counts per account after pull: campaigns / ad sets / ads / spend rows.
- Per-account spend total + a 1-ad spot-check against a fresh live insights GET
  (the G1 1% rule now per account; print the variance table).
- Idempotency proof: run the full pull TWICE; row counts must not change on the
  second run (upsert proven).
- G1 account check: `?adAccount=4749960348632164` still returns ₹51,480.77-class
  totals (no regression from re-pull), still mapped to cl_upcurvv.
- `pnpm test` + `pnpm build` green; `git status` clean; no secrets in the commit.

## Docs + commit

- GOLIVE_STATUS.md: new row "Multi-account onboarding (N of 7 accessible)" with
  per-account LIVE / BLOCKED status + evidence (commit, pull timestamp, row
  counts).
- DECISIONS.md: D-xx for the auto client-naming rule + any new decision.
- SESSION_REPORT.md: what landed, what's blocked on which account + what to
  provide.
- Commit: `[REVIEW]` (touches spend/lead paths + tenant data).

## Rules

- 0 manual data entry: if a value must come from Meta, you pull it from Meta.
- 0 fake success: an account that 403s is BLOCKED with the exact Meta error,
  not "onboarded".
- The 6 new accounts are G1-gate-free (no spend reconciliation week needed per
  account yet — that's G9; here the gate is: entities + spend pulled, reports
  render, filters work, idempotent).
- When done, end with: "Next gate = G4 webhooks per client" + the per-client
  webhook URL list (client → https://<current-tunnel>/api/webhooks/... — tunnel
  still the dev base until G10).
