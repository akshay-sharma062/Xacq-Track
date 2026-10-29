# Row-Level Security (Postgres)

The spec (section 10) requires that **every query is filtered by
`client_id` at the database level, not only in the app code.** The app does
this already (every `prisma` call in `src/lib/` takes `clientId`), but RLS is
the second line of defence: even if a future bug forgets to scope a query,
the database refuses to return another client's rows.

RLS only exists in Postgres. The local demo runs on SQLite (no RLS), so this
is the migration path when you flip the datasource (see `deploy.md`).

## 1. Set the tenant per connection

```sql
-- App sets this on every request (Supabase: via pg_catalog.set_config / a
-- Postgres session; a raw app: as the first query of the transaction).
SELECT set_config('app.client_id', '<uuid>', false);
```

## 2. Enable + policy every tenant-scoped table

```sql
-- Tables that carry a `client_id` (the tenancy boundary):
ALTER TABLE clients          ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads            ENABLE ROW LEVEL SECURITY;
ALTER TABLE touchpoints      ENABLE ROW LEVEL SECURITY;
ALTER TABLE events           ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_campaigns     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_sets          ENABLE ROW LEVEL SECURITY;
ALTER TABLE ads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls            ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_lead_forms  ENABLE ROW LEVEL SECURITY;

-- One policy per table (repeat, or generate in a loop):
CREATE POLICY client_isolation ON leads
  USING (client_id = current_setting('app.client_id')::uuid)
  WITH CHECK (client_id = current_setting('app.client_id')::uuid);
```

> If you use `client_id` as a `cuid()` string (not `uuid`), drop the `::uuid`
> cast and compare as text. The schema in this repo uses string ids.

## 3. Tables that are NOT client-scoped

- `workspaces`, `users` — workspace-scoped. A user sees only clients in their
  `workspace_id`; that's enforced by the app's `Session.clientIds` list
  (`src/lib/session.ts`), and in prod by a `workspaces`/`users` join.
- `visitors` — has a nullable `client_id`; allow when it matches, or when it
  is the user's own visitor.

## 4. The `outbound_events` CAPI table is special

It's client-scoped **and** it's the "never send twice" record. RLS protects
read/write; the `UNIQUE dedupKey` + `UNIQUE event_id` columns are what make
the dedup crash-safe. Don't relax those constraints when you add RLS.

## 5. Who can run the migration

DBAs / the product owner's infra owner, not app code. Review the policy set
before the pilot goes live (this is part of the `SECURITY_CHECKLIST.md`
sign-off).
