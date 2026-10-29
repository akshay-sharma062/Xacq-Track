# Deployment

Xacqora Track is built to run **locally with zero services** (SQLite) and to
deploy to **Vercel + a managed Postgres in the Mumbai region** (data stays in
India, per spec section 8).

## 1. Local (already set up)

```bash
pnpm install
pnpm db:migrate   # SQLite -> prisma/dev.db
pnpm db:seed
pnpm dev
```

## 2. Flip the data source to Postgres

1. In `prisma/schema.prisma`, change the datasource provider:

   ```
   datasource db {
     provider = "postgresql"   // was "sqlite"
     url      = env("DATABASE_URL")
   }
   ```

   The models are **provider-agnostic on purpose** (no Prisma enums, no `Json`
   field, no `@db.*` native types) so this is a one-line flip + `db push`.
   JSON-ish payloads are `String` blobs parsed in the app layer.

2. Point `DATABASE_URL` at Supabase / Neon:

   ```
   DATABASE_URL="postgresql://user:pass@db.<ref>.mumbai.supabase.co:5432/postgres"
   ```

3. Generate versioned migrations:

   ```bash
   npx prisma migrate dev --name init
   npx prisma migrate deploy   # in CI / prod
   ```

4. Enable **Postgres Row-Level Security** (see `rls.md`). This is the
   difference between "the app scopes every query" (what the code does) and
   "the database itself will not return another client's rows" (what the spec
   section 10 requires).

## 3. Secrets (server-side only)

| Var | Notes |
|---|---|
| `META_ACCESS_TOKEN` | A **system-user** token (not a user token — those expire). Business access needs `ads_read` + leadgen. Empty → Meta pull + CAPI run in simulation mode. |
| `META_LEADGEN_WEBHOOK_VERIFY_TOKEN` | The `hub.verify_token` for the Meta leadgen webhook GET handshake. |
| `RAZORPAY_WEBHOOK_SECRET` / `CASHFREE_WEBHOOK_SECRET` | HMAC secrets. Per-client secrets live on `Client.webhookSecret` in the DB; these env vars are the default fallback. |
| `INGEST_RATE_LIMIT_PER_MIN` | Public ingest throttle (default 120). |

Never put real client lead data or access tokens in `.env` committed to git —
use the fake seed. `.env` is gitignored.

## 4. Auth

The local demo resolves the acting user from the `DEMO_USER` env + a
`xacqora_user` cookie (see `src/lib/session.ts`). For real logins, swap
`currentUser()` to read the Supabase/Clerk session; the `Session` shape and
the role→action matrix (`can()`) stay unchanged. Enforce 2FA at that layer.

## 5. The app

- `pnpm build` → `next build`. Deploy the Next app to Vercel.
- Keep `public/xt.js` served verbatim (it's the tracking script clients paste
  into their landing pages). Set `NEXT_PUBLIC_BASE_URL` so the
  integrations-hub webhook URLs are correct in prod.
- `recharts` is in deps but unused (charts are pure SVG, see `ui.tsx`);
  drop it or reintroduce once a stable React-19 build ships.

## 6. Scheduled jobs (not yet wired)

The Meta ads pull (`meta/pull.ts`) and CAPI send (`meta/capi.ts`) are
callable now; you still need a trigger to *run* them:

- **Nightly + 3-hourly Meta pull** (spec 5.7) → Inngest / Trigger.dev /
  BullMQ cron, or Vercel cron hitting `POST /api/meta/pull`.
- **Monday 9 AM IST weekly summary** (spec 7) → cron that calls
  `weeklySummary()` per client and writes it to the portal + PDF.
- **Retention cleanup** (`retention.ts`) → nightly purge past policy.
