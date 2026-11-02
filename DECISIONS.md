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
