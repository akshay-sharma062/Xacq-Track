# Module notes

One section per module (spec section 8: keep a short README per module so the
next AI session has context). Each names the **files**, the **spec section**
it implements, and what's **done vs. next**.

## 1. Tracking script — `xt/` → `public/xt.js` (spec 5.1)
One line of JS in the `<head>` of any landing page. On load it reads all
UTMs + `fbclid` + ad/adset/campaign ids, makes a first-party `visitor_id`
cookie (365 days), derives `fbc` from `fbclid`, and posts a touchpoint to
`/api/ingest`. Auto-fills hidden fields on forms; queues-and-retries on
network failure so a click is never lost. **5 KB** minified (budget <10 KB).
- `xt/src/index.ts` — source; `xt/build.mjs` — esbuild build; `public/demo.html` — a live page to test it.

## 2. Ingest pipeline — `src/lib/ingest.ts` (architecture + 4/5/6)
The single choke-point. Every record (Meta lead, payment webhook, webinar
join, WhatsApp, CSV import, xt.js touchpoint) flows through `processInbound()`:
1. **verify** signature/secret first (spec 10); 2. **normalise** via the
adapter; 3. **resolve/create the lead** (phone-first, never cross-client);
4. **record the payment** (dedup on gateway txn id; source-unknown fallback);
5. **write the timeline event + a touchpoint row** (attribution reads it);
6. **auto stage move** (forward only, never out of Paid/Lost); 7. **enqueue
the CAPI event** (outbox pattern — never sent inline, so a spike can't
drop events or block the webhook ACK).

## 3. Platform adapters — `src/lib/adapters/` (spec 6)
One adapter per platform, each with a `parse()`, a **saved sample payload**
(replayed by `test/adapters.test.ts`), and a `verify()` where the platform
provides a signature. Meta's Marketing pull is *not* a webhook — it's
`meta/pull.ts`.

## 4. Identity — `src/lib/identity.ts` (spec 4)
E.164 phone normalisation (strip spaces/0/91), phone-first matching,
visitor→lead attach, duplicate-candidate detection. Pure + unit-tested.

## 5. Attribution — `src/lib/attribution.ts` (spec 7)
Four models (last-paid-click default, first-click, linear, lead-source),
editable window, "Organic / unknown" fallback, and ad/adset/campaign
roll-up. Pure + unit-tested. **This absorbed the old UTM-report-generator
logic** (new-vs-old, proportional split).

## 6. CAPI — `src/lib/capi.ts`, `hash.ts`, `meta/capi.ts` (spec 5.8)
Payload builder + SHA-256 hashing + `event_id` dedup + the two hard rules
(never send twice; never Purchase for a refund). `meta/capi.ts` is the
send/retry queue: real HTTP with a token, deterministic simulation without.

## 7. Meta ads pull — `src/lib/meta/pull.ts` (spec 5.7)
Scheduled pull of campaigns/ad sets/ads/creatives + daily insights, stored in
native currency **and** INR via the stored daily FX rate (`fx.ts`). `simulatePull`
is the offline path.

## 8. Reports — `src/lib/reports.ts` (spec 7)
Funnel, ad performance, wasted spend, new-vs-old, Meta-vs-Track, source mix,
weekly summary. Every number CSV/Excel-exportable; revenue net of refunds.

## 9. Pipeline / leads service — `src/lib/leads.ts` (spec 5.4/5.5)
Search + filters, the timeline, stage moves, assignment, notes, duplicate
merge. Centralises masking + scoping so every screen agrees.

## 10. Sessions + permissions — `src/lib/session.ts` (spec 5.10)
`currentUser()` (cookie/`DEMO_USER` stand-in for Supabase Auth), the
role→action matrix (`can()`), phone masking, client scoping.

## 11. Security — `src/lib/security.ts` (spec 10)
Rate limiting, webhook-secret resolution, audit logging of exports + actions.

## API routes — `src/app/api/` (spec: one codebase for app + API)
`webhooks/[platform]`, `ingest`, `leads`, `leads/[id]`, `reports`, `capi`,
`meta/pull`, `import`, `duplicates`, `audit`, `integrations`, `session`,
`settings`. All Next 15 **async-params**; all scoping + permission-checked
via `api-utils.ts`.

## 14 screens — `src/app/`
Dashboard, Leads, Lead timeline, Pipeline, Duplicates, Integrations, Meta
pull + CAPI, Reports, CSV import, Team & roles, Audit log, Settings. Shared
shell in `components/` (Sidebar, Topbar, a pure-SVG UI kit in `ui.tsx`).
