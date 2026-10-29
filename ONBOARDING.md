# Client onboarding checklist

How to bring a new client onto Xacqora Track (internal Foremost Leads clients
first, SaaS later — spec section 2 / 9). The goal: a client's leads start
landing on the right lead record within a day, and the Monday report runs
with zero manual work.

Run this **per client**. A pilot client is done when every box is ticked.

## 1. Set up the tenant (owner/admin)
- [ ] Create the `Client` row: name, currency (INR), timezone
      (`Asia/Kolkata`), **offer price** (used for the profit math).
- [ ] Set the **attribution default**: model + window
      (default `last_paid_click`, 30 days — spec 7, because webinar buyers
      often pay 1–3 weeks after the first click).
- [ ] Create a `Funnel` per offer (webinar / paid workshop / call booking /
      direct checkout) with its stage list.
- [ ] Give the client a **webhook shared secret** (`Client.webhookSecret`);
      copy it into each platform's webhook config.

## 2. Wire the ad tracking (media buyer)
- [ ] Confirm **every Meta ad URL uses the dynamic parameters**
      `{{ad.id}}`, `{{adset.id}}`, `{{campaign.id}}` (spec Phase-1 gate:
      "Every Meta ad URL on pilot accounts uses dynamic campaign, ad set and
      ad ID parameters").
- [ ] Paste the tracking script into every landing page:
      `<script src="/xt.js" data-client="<clientId>" defer></script>`.
- [ ] **Verify:** run `public/demo.html`, open DevTools, and watch a
      `POST /api/ingest` fire with the right `visitor_id` + ad ids.
- [ ] **Verify:** ≥ 95 % of landing-page leads carry an `ad_id` or a UTM
      (Phase-1 gate).

## 3. Connect Meta Lead Forms (Instant Forms)
- [ ] Connect the Facebook Page (Meta login), subscribe the `leadgen`
      webhook to `/api/webhooks/meta?client=<clientId>`.
- [ ] Fill the **field-mapping screen** (`MetaLeadForm.fieldsMapping`):
      which question is phone / email / name / city / custom.
- [ ] **Verify:** submit a test Instant Form; the lead must appear **with
      `ad_id`** within 1 minute (Phase-1 gate: "100 % of pilot Instant
      Form leads land within 1 minute with ad_id").

## 4. Wire each payment + engagement platform
For every platform the client uses, add its webhook →
`/api/webhooks/<platform>?client=<clientId>` and tick off where it lands:

- [ ] **Payments** (Razorpay / Cashfree / Cosmofeed / TagMango /
      FlexiFunnels) — verify the gateway transaction id dedups; a payment
      with no matching lead creates a "source unknown" lead (still counts in
      revenue).
- [ ] **Webinars** (Aevent / Zoom) — registered / joined / left / replay.
- [ ] **Calls** (Calendly) — booked / cancelled (match by email + the phone
      question).
- [ ] **WhatsApp** (WATI / Interakt / AiSensy / Periskope, or Pabbly) —
      sent / replied.
- [ ] Use the **integrations-hub "test button"** on each platform: it sends
      a fake event and shows exactly where it landed (spec 6).

## 5. Import the history
- [ ] Upload the existing Google Sheet / CSV of old leads + sales via
      **CSV import**. Map the columns (Phone / Email / Amount / Status).
      Rows flow through the same pipeline, so old sales backfill onto the
      right leads and dedup correctly.

## 6. Prove the money matches (gate before Phase 3)
- [ ] Xacqora Track net revenue == gateway dashboards, within **2 %**.
- [ ] Xacqora Track spend == Meta Ads Manager, within **1 %**.
- [ ] See `TESTING.md` → "Pilot accuracy checks".

## 7. Open the client portal (Phase 4)
- [ ] Create the client's login (`User`, role `viewer`, scoped to this
      client only). Phones show masked to the last 4 by default.
- [ ] Confirm the **Monday 9 AM IST** summary reaches the portal without
      manual work.
- [ ] Walk through `SECURITY_CHECKLIST.md` before the client goes live.

## Data-privacy sign-off (before pilot goes live)
Per the spec, a legal/compliance owner must confirm:
- [ ] Consent wording on the client's landing page + lead form covers
      tracking and sharing with Meta.
- [ ] Data-retention rules (defaults in `src/lib/retention.ts`).
- [ ] India's DPDP Act applies — raw phone/email are hashed with SHA-256
      before leaving the server; a client can request deletion of a lead.
