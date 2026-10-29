# Security, privacy & compliance checklist

Spec section 10 — "these rules are not optional in any phase." Xacqora Track
holds phone numbers and payment records of lakhs of people across many
clients, so one leak hurts every client at once.

## Where each control lives in code

| Spec requirement | Implementation |
|---|---|
| **Row-level security** (every query filtered by `client_id` at the DB level, not just app code) | App layer: every `prisma` call in `src/lib/` scopes by `clientId` (the reports, leads, reports, and ingest modules all take `clientId`). DB layer: **Postgres RLS policies** — below. |
| **Meta tokens / gateway secrets / webhook secrets encrypted, never in code or frontend** | Stored on `Client.webhookSecret` + env (`META_ACCESS_TOKEN`). Env-only in this repo; wire encryption at rest in prod. |
| **Every inbound webhook verified by signature or shared secret before processing** | `src/lib/ingest.ts` calls `adapter.verify()` **first**, before any write. Adapters with a real signature (Razorpay/Cashfree HMAC, Meta `X-Hub` token) implement it; shared-secret platforms use the header compare. |
| **2-factor login for all Foremost Leads users** | `User.twoFactor` column + flag on the admin screen. Enforce at the auth layer (Supabase) when wired. |
| **Phone / email masked for roles that don't need them; exports logged** | `src/lib/session.ts::maskPhone()` + the role→action matrix. `src/lib/security.ts::auditExport()` logs every export. |
| **Daily DB backups, restore tested monthly** | Platform concern (Supabase/Neon PITR). Add a monthly restore drill. |
| **Rate limits on the public ingest API** | `src/lib/security.ts::rateLimit()` on `/api/ingest` + each webhook. |
| **Raw phone/email hashed SHA-256 before sending to Meta; raw values never leave** | `src/lib/hash.ts` — single source of truth for the CAPI hashes. |
| **Client can request deletion of a lead → stops future CAPI** | `Lead.deletedAt` soft-delete; `ingest` + CAPI send check it. |
| **Meta Lead Form data never shared between clients** | All Meta-ingest paths scope to one `clientId`. |

## Postgres RLS (enable when the datasource flips to Postgres)

The local demo runs on SQLite, which has no RLS. When you switch the
datasource provider to `postgresql` (spec: Supabase / Neon, Mumbai region),
add these policies so the DB itself enforces tenancy — the app-layer scoping
becomes a second line of defence, not the only one:

```sql
-- Enable RLS on every tenant-scoped table and key by client_id.
-- The app sets `app.client_id` per request via:
--   ALTER ROLE ... SET app.client_id = '<uuid>';   (or Supabase's set_config)

ALTER TABLE leads          ENABLE ROW LEVEL SECURITY;
ALTER TABLE events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE touchpoints    ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_logs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs     ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON leads
  USING (client_id = current_setting('app.client_id')::uuid);
-- …repeat the same policy shape for each table above.
```

Supabase makes this a `for all` policy per table keyed on `client_id`
(either directly or via a `clients.workspace_id` join for the workspace-level
rules). Keep the policy set **owned by DBAs**, not app code.

## Crypto
- **Phone/email for CAPI:** SHA-256. Phone is E.164 **without the `+`**
  (spec 5.8); email is lowercased. One helper (`hash.ts`) so every CAPI
  path — webhook replay, manual events, scheduled send — produces
  byte-identical hashes.
- **HMAC webhooks:** Razorpay signs the raw body with the shared secret
  (HMAC-SHA256); Cashfree signs `timestamp:body`. Compare in
  constant time.
- **Tokens:** system-user Meta token preferred (spec 5.7). Never a user
  access token — it expires.

## DPDP Act (India)
- Consent line on the landing page + lead form covering tracking and
  sharing with Meta.
- Retention: `src/lib/retention.ts` defines per-table retention; wire a
  scheduled cleanup job to it (not yet built — see `docs/roadmap` in
  `README.md`).
- Deletion: a lead's `deletedAt` halts future CAPI and marks it for
  eventual purge.

## Pre-pilot gate
Before the pilot client goes live, a legal/compliance owner signs off the
whole list above + the retention/consent wording. Until then, run in the
internal Foremost Leads workspace only.
