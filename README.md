# Xacqora Track

**Lead tracker & attribution CRM for ad-led coaching funnels.** For every lead, it shows
which ad brought them in, every ad they clicked after, where they stand in the funnel,
and whether they paid — then sends the real outcomes (Registered, Attended, Purchase)
back to Meta via the Conversions API so Meta finds more buyers, not just form-fillers.

Built to the product spec in `_extracted_spec.txt`. This repository contains the full
foundation: the data model, the single ingest pipeline, 14 platform adapters, the
attribution engine, the CAPI loop, 14 screens, the tracking script, and the test suite.

> **Note on build progress:** the data layer, pipeline, API, and UI are all wired and
> typecheck clean; the test suite is green. Remaining work is listed under
> [_What's built vs. stubbed_](#whats-built-vs-stubbed).

---

## Quick start

```bash
pnpm install
pnpm db:migrate    # prisma db push (SQLite) — creates prisma/dev.db
pnpm db:seed       # loads the cross-linked demo dataset
pnpm xt:build      # bundles the tracking script to public/xt.js
pnpm dev           # next dev → http://localhost:3000
```

Open the app, use the top-right **persona switcher** to act as any role (owner, admin,
media buyer, sales rep, viewer), and the **client switcher** to scope the data. Every
screen reads live from the seeded SQLite DB.

Run the tests:

```bash
pnpm test          # 83 tests: identity, attribution, CAPI, FX, adapter replay,
                   # ingest e2e (against a temp DB), and reports
```

---

## What's built vs. stubbed

### Built (working end-to-end, tested where noted)
| Area | Where | Status |
|---|---|---|
| Data model (18 tables, RLS-ready) | `prisma/schema.prisma` | ✅ SQLite local, Postgres prod |
| Demo seed (fully cross-linked) | `src/lib/seed.ts` + `prisma/seed.ts` | ✅ 12 leads, 26 events, 90+ spend rows |
| Identity rules (E.164 phone-first) | `src/lib/identity.ts` | ✅ unit-tested |
| Attribution engine (4 models) | `src/lib/attribution.ts` | ✅ unit-tested |
| CAPI payload + dedup + hashing | `src/lib/capi.ts`, `src/lib/hash.ts` | ✅ unit-tested |
| FX / currency | `src/lib/fx.ts` | ✅ unit-tested |
| Single ingest pipeline | `src/lib/ingest.ts` | ✅ e2e-tested against a real DB |
| 14 platform adapters + samples | `src/lib/adapters/` | ✅ replay-tested |
| Meta ads pull (real + simulated) | `src/lib/meta/pull.ts` | ✅ |
| CAPI send + retry queue | `src/lib/meta/capi.ts` | ✅ dedup + refund-guard tested |
| Retention policies | `src/lib/retention.ts` | ✅ |
| All reports (spec §7) | `src/lib/reports.ts` | ✅ tested against seeded data |
| Sessions + role matrix + masking | `src/lib/session.ts` | ✅ |
| Security (rate limit, audit, secrets) | `src/lib/security.ts` | ✅ |
| API routes (13) | `src/app/api/` | ✅ typed, Next 15 async-params |
| 14 screens | `src/app/` | ✅ server-rendered, live data |
| Tracking script (xt.js, <10KB) | `xt/` → `public/xt.js` | ✅ 5KB bundle |

### Stubbed / next (documented, not yet wired)
- **Real auth**: `src/lib/session.ts` uses a cookie + `DEMO_USER` env as a stand-in for
  Supabase Auth (the spec's pick). Swap only `currentUser()`; the `Session` shape and
  the `can()` matrix stay.
- **Scheduled jobs** (nightly Meta pull, Monday-9 AM weekly summary): the pull + CAPI
  send are callable now; a cron/Inngest trigger to *run* them is not yet wired.
- **PDF export** for the weekly summary: CSV/Excel are done; PDF generation is not.
- **Row-Level Security** in Postgres: query-layer scoping is implemented; the actual
  Postgres RLS policies are documented in `SECURITY_CHECKLIST.md` for when the
  datasource flips to Postgres.
- **`recharts`**: installed but intentionally unused — charts are pure SVG
  (`src/app/components/ui.tsx`) to avoid a React-19 peer-dep conflict. Drop the dep
  or reintroduce once a stable recharts-for-React-19 release lands.

---

## Layout

```
prisma/            schema.prisma (single source of truth), seed.ts, migrate.ts, dev.db
src/lib/           framework-free domain: identity, attribution, capi, fx, hash,
                   ingest, reports, retention, session, security, leads, dashboard,
                   seed, meta/{pull,capi}, adapters/{14 platforms}, csv
src/app/
  api/             13 route handlers: webhooks/[platform], ingest, leads, leads/[id],
                   reports, capi, meta/pull, import, duplicates, audit, integrations,
                   session, settings
  *.tsx            14 screens: dashboard, leads, leads/[id] (timeline), pipeline,
                   duplicates, integrations, meta, reports, import, admin, audit,
                   settings  (+ shared shell: layout, Sidebar, Topbar, ui kit)
xt/                tracking script source (TS) + esbuild build
public/xt.js       the bundled <script> you paste into landing pages
test/              83 tests (vitest)
.env / .env.example  DATABASE_URL + demo persona + (empty) secrets
```

## The tracking script (xt.js)

Paste into the `<head>` of any landing page (Lovable, FlexiFunnels, TagMango,
WordPress):

```html
<script src="/xt.js" data-client="cl_fitness" defer></script>
```

On load it reads all UTMs + `fbclid` + ad/adset/campaign ids, creates a first-party
`visitor_id` cookie (365 days), derives `fbc` from `fbclid`, and posts a touchpoint to
`/api/ingest`. It auto-fills hidden fields on any form and queues-and-retries on
network failure so a click is never lost. ~5 KB minified, zero page-speed impact.
The full page to try it live: `public/demo.html`.

## Production path

1. Flip `prisma/schema.prisma` datasource to `provider = "postgresql"` and point
   `DATABASE_URL` at Supabase/Neon (Mumbai region, per the spec).
2. `npx prisma migrate dev` for versioned migrations; enable Postgres RLS
   (see `SECURITY_CHECKLIST.md`).
3. Set `META_ACCESS_TOKEN` (a system-user token) so the Meta pull + CAPI send run
   live instead of the deterministic simulation.
4. Swap the session layer for Supabase Auth + Clerk roles; keep `Session`/`can()`.
5. Deploy Next on Vercel; keep Postgres in-region.
