# Changelog

All notable changes to Xacqora Track. This repo replaces the standalone
**UTM report generator** project — its logic (campaign-name cleanup, new-vs-old
leads, proportional spend split) now lives in the Phase-3 reports module
(`src/lib/reports.ts`, `newVsOld` + `adPerformance`), per the spec's closing note.

## 0.1.0 — Foundation (initial)
### Added
- **Data model** (`prisma/schema.prisma`): Workspace, Client, Funnel, Visitor,
  Lead, Touchpoint, Event, Payment, Ad entity tree, Spend, Task/Note/Call,
  User, WebhookLog, OutboundEvent (CAPI), AuditLog, MetaLeadForm + field
  mapping, AttributionRule, ReportConfig. Provider-agnostic (no Prisma
  enums/Json) so it runs on SQLite locally and Postgres in prod.
- **Single ingest pipeline** (`src/lib/ingest.ts`): every inbound record flows
  through one choke-point — identity rules, payment dedup, auto stage moves,
  CAPI outbox. A 5,000-webinar-join spike stays lossless.
- **Identity rules** (`src/lib/identity.ts`): E.164 phone normalisation,
  phone-first matching, never-merge-across-clients, duplicate detection,
  visitor→lead attach.
- **Attribution engine** (`src/lib/attribution.ts`): last-paid-click
  (default), first-click, linear, lead-source; editable window; "Organic /
  unknown" fallback; ad/adset/campaign roll-up.
- **CAPI** (`src/lib/capi.ts`, `hash.ts`, `meta/capi.ts`): SHA-256
  phone/email hashing, `event_id` dedup, "never send twice", "never Purchase
  for a refund", match-quality estimate, retry queue with a real + simulated
  send path.
- **14 platform adapters** (`src/lib/adapters/`): Meta Lead Form, Meta
  Marketing pull, xt.js, Razorpay, Cashfree, Cosmofeed, TagMango, FlexiFunnels,
  Aevent, Zoom, Calendly, Pabbly, WhatsApp, Google Sheets/CSV — each with a
  saved sample payload + signature verifier where the platform provides one.
- **All 7 reports** (`src/lib/reports.ts`): funnel, ad performance, wasted
  spend, new-vs-old, Meta-vs-Track, source mix, weekly summary — CSV/Excel
  export, revenue net of refunds.
- **14 screens** (`src/app/`): dashboard, lead list, lead timeline (main
  screen), pipeline, duplicates, integrations hub, Meta pull + CAPI, reports,
  CSV import, team & roles, audit log, settings.
- **Sessions + permissions** (`src/lib/session.ts`): role→action matrix,
  phone masking, client scoping.
- **Security** (`src/lib/security.ts`): rate limiting, webhook-secret
  resolution, audit logging of exports + phone access.
- **Tracking script** (`xt/`): 5 KB esbuild bundle.
- **83 tests** (`test/`): pure-logic units + DB-backed ingest e2e + reports
  against seeded data.

### Demo data
Two workspaces, 3 clients, 12 leads across the full journey (registered →
attended → hot → call → paid, incl. a refund, a "source unknown" payment, and
a duplicate pair), 30-day ad spend series, webhook + CAPI + audit fixtures.
All fake (spec rule 8: never put real client data in the repo).
