# DECISIONS — Xacqora Track

Product-owner decisions that change the data model or go-live behaviour,
numbered D-xx. Each records what changed, why, and where it is enforced in
code, so a later reader never has to re-derive it from git history.

---

## D-01 — Ad account is the primary organizing entity (2026-10-30)

**Decision:** the data model is re-centered on the **Meta ad account**. A
client is named after its ad-account owner. Every screen/report filters key
off the ad account (`?client=<id>` AND/OR `?adAccount=<metaId>`), then
campaign → ad set → ad → stage → date.

**Scope:** we start with ONE account — **Upcurvv**
(`act_4749960348632164`, "Upcurvv-FML", INR), the G1 LIVE account.

**Enforced in:**
- `prisma/schema.prisma` — `AdAccount` is the link row
  (`metaId`, `name`, `displayOwnerName`, `currency`, `clientId`, `status`);
  `AdCampaign` / `AdSet` / `Ad` / `Spend` all carry `adAccountId`
  (verified present from the G1 pull — no backfill needed).
- New client `cl_upcurvv` ("Upcurvv", INR) = the single client; 1 client ↔
  1..N ad accounts (spec §4 multi-tenant invariant).
- `src/lib/reports.ts` — `resolveAdAccountId(prisma, clientId, metaId)` maps
  a Meta `metaId` (what a URL carries) to the internal link-row id and verifies
  it belongs to the client; the SPEND-family reports (`funnelReport`,
  `adPerformance`, `wastedSpend`, `metaVsTrack`, `weeklySummary`) accept an
  optional `adAccountId` and narrow to it. Lead-side counts stay
  client-scoped (a lead can be touched by ads from any account).
- `src/app/api/reports/route.ts` — reads `?adAccount=<metaId>` and threads it
  through.
- `src/app/api/session/route.ts` + `Topbar.tsx` — the ad-account filter
  options come from the `AdAccount` link rows (real DB data, not a canned
  list), driving a `?adAccount=` URL param.
- `src/lib/meta/pull.ts` — the pull upsert maintains `displayOwnerName` +
  Meta `account_status` on the link row.

**Why:** a client is "the business that owns an ad account". With one account
today the UI shows it as the only option — the control is real and scales to
N accounts without a schema change.

---

## D-02 — Seed/dummy data purged; dev data = real G1 rows only (2026-10-30)

**Decision:** no seed or dummy data anywhere in dev or reports.

**Enforced in:**
- `src/lib/seed.ts` — `pnpm db:seed` now creates ONLY: the workspace, the two
  Foremost Leads staff users (owner + admin), the `cl_upcurvv` client, and the
  empty `AdAccount` link row for `act_4749960348632164`. NO leads, NO events,
  NO fake spend. Real campaigns/ads/daily spend arrive via the G1 pull job;
  lead-side rows arrive via live G3 (xt.js) / G4 (gateway webhooks) traffic.
- The old rich fixture set (`cl_fitness` / `cl_iitprep` / `cl_trial_saas`,
  12 leads, the 30-day fake USD×84 spend series, `aa_123`/`aa_222` ad trees,
  demo personas) was removed. `dev.db` was re-migrated: the G1 real tree was
  re-parented `cl_fitness → cl_upcurvv` and every seed row purged.
- **A 0-lead dashboard is a valid state.** Post-purge honesty copy: the lead
  list shows "No leads yet — live traffic starts when G3 (xt.js on
  join.upcurvv.com/cll) and G4 (gateway webhooks) are live." No stored-data
  "12/12 100%" snapshot claims anywhere.

**Tests:** `test/helpers.ts` `freshDb()` starts from the tenancy bootstrap,
never lead/event/spend fixtures; `ingest.test.ts` + `reports.test.ts` build
their own ad-tree + lead fixtures (spec §8: replay/fixture-own), not seed
data. `fx-store`/`pull-scheduler` tests use `freshDb({ seed: false })`.

---

## D-03 — G3 gate measured on LIVE traffic only (2026-10-30)

**Decision:** the G3 "≥95% of landing-page leads carry an ad_id or UTM" gate
is measured only on real post-deployment traffic under `cl_upcurvv`. 0 leads
is **not** a gate failure — it is the pre-traffic state. A gate pass requires
some live clicks (≥ ~20) before it is meaningful; until then G3 status is
"AWAITING LIVE TRAFFIC", never "MET". No seed backfill counts toward it.

**G3 handoff:** `G3_INPUTS.md` `client` + `pilot clientIds` = `cl_upcurvv`;
the paste-ready snippet now carries a concrete `data-client="cl_upcurvv"`.

---

## D-04 — Multi-account onboarding: zero-manual, auto client-naming (2026-11-02)

**Decision:** onboarding MORE Meta ad accounts is ZERO-MANUAL — the operator
gives ad-account IDs (`META_AD_ACCOUNT_IDS`), and the app pulls everything else
from the Meta Marketing API: identity (name / currency / `account_status`),
the tenant structure, campaigns, ad sets, ads, creatives, daily spend.

**Client naming rule (per the PO decision of 10-30):** a client is named
after its ad-account owner. So each new account auto-creates one client
`cl_<slugified-account-name>` (e.g. "CardGenius 2" → `cl_cardgenius-2`).
Accounts of one business can later be merged under one client via a
documented merge — **not done now** (today the mapping is provisional 1:1;
the existing G1 mapping `act_4749960348632164 → cl_upcurvv` is NEVER
re-parented).

**Onboarding pipeline (enforced in `src/lib/meta/pull.ts`):**
1. `fetchAccountIdentity(ref)` — read name/currency/status from the API
   (zero manual entry). A 401/403 throws a structured `MetaAccessError`
   carrying Meta's permission name.
2. `resolveOrCreateClientForAccount(ref, …)` — idempotent tenant provisioning:
   existing link row → reuse its client (never re-parent); otherwise create
   `cl_<slug>` + link row. Slug collisions across distinct accounts get a
   ref-tail suffix.
3. `onboardAccounts(refs, token)` — the orchestrator: read identity →
   provision → full `pullAdAccount` per account. One account's 403 is
   isolated (recorded with the exact Meta error + permission, `blocked[]`)
   and the others continue. A BLOCKED account is NEVER reported as
   "onboarded" (the 0-fake-success rule).

**Scheduler** (`src/jobs/pull-scheduler.ts`): `runDuePulls` now (a) pulls
every DB-known (client, adAccount) pair through the fixed mapping, and
(b) onboards any `META_AD_ACCOUNT_IDS` entry that has no link row yet.
Per-account failures are isolated and surfaced with `permission`/`status`
fields so a `BLOCKED: needs <permission>` can be recorded exactly.

**Idempotency + no double-count (found + fixed this ticket):** Meta's
no-range 30-day rollup stamps `day = date_stop`, which ADVANCES each pull.
The `(adMetaId, day)` upsert key therefore STACKED a second overlapping
window on re-pull (G1 grew ₹51,480.77 → ₹115,887.55 = two windows).
`upsertPulled` now does a **SNAPSHOT REPLACE**: it deletes the account's
previous spend snapshot before writing the new one. A re-pull is a no-op on
row counts and never duplicates spend. The pull only reaches the delete
after every API call succeeded, so a failed re-pull can never wipe a good
snapshot. Proven by running the full onboarding twice — counts unchanged.

**Filters:** the `?adAccount=` + Topbar selector stays DB-driven
(`/api/session.adAccounts` lists every accessible account); the dashboard
shows per-account spend / campaigns / ads / leads (0 until G3/G4 traffic —
honest empty state).

**Scope rule:** the 6 new accounts are G1-gate-FREE — no per-account spend
reconciliation week yet (that's G9). This ticket's gate: entities + spend
pulled, reports render, filters work, idempotent, G1 non-regression.

**Live result (2026-11-02, [REVIEW] commit):** all 7 `META_AD_ACCOUNT_IDS`
accessible → 7/7 onboarded, zero `BLOCKED` rows (the token reaches every
account; no permission grants needed). Spot-check vs a *fresh* live `/insights`
read is a same-rolling-window comparison: the G1 account (act_…2164) is exact
**0.000%**; the high-volume accounts show a small Δ **only** when the stored
snapshot's `date_stop` is a few days behind the live 30-day window — re-pulling
advances `date_stop` and the Δ collapses back to 0.000% (verified live 2026-11-02:
Piyush/CardGenius/G1 all 0.000% after the window advanced; residual 1.4–4.0% on the
rows whose `date_stop` had not yet advanced = window lag, not a data error). G1
total is now ₹64,406.78 — a live-window growth (the 30-day
rollup advanced), kept a single window by the SNAPSHOT-REPLACE, still mapped to
`cl_upcurvv`. One AED account ("The Job Workshop") stores native AED with
`inrSpend=0` because the live FX fetch was sandbox-blocked — spec 5.7
backfill, not a fake; making FX real on-machine is Dashboard-V2 §4.
