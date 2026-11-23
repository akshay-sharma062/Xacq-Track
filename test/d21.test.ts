/**
 * D-21 — Lovable the way FlexiFunnels was (D-18/D-19), adapted to what
 * Lovable can ACTUALLY send:
 *
 *   VERDICTS (Lovable docs: apps are "backed by editable code" + "synced to
 *   GitHub" — a React + Vite + Supabase code builder, NOT a no-code
 *   form-to-webhook provider):
 *     (a) CUSTOM JS INJECTION = YES  → the D-17 tracker.js snippet pasted
 *         into the Lovable app's head tracks it (no new code; a TrackingProject
 *         + the generated snippet, asserted here).
 *     (b) NATIVE FORM→WEBHOOK  = NO  → lead capture only if the PO hand-edits
 *         the app's React code to fetch()-POST our UNSIGNED
 *         /api/webhooks/lovable endpoint. That path is proven here.
 *
 *   Proven at the repo's test boundary (lib layer + source contract asserts,
 *   the D-18/D-19 precedent):
 *     1. the lovable adapter extracts the flat form fields -> named
 *        NormalizedInbound props + record.meta (no field lost);
 *     2. the [platform] ingest path accepts /api/webhooks/lovable UNSIGNED
 *        (an empty connection secret + no x-webhook-secret header → a real
 *        lead lands, like D-18's FlexiFunnels fix — and lovable creates as
 *        UNSIGNED_ONLY, secret "");
 *     3. a Lovable tracking project generates the CORRECT tracker.js snippet
 *        (data-project=<the project id> + the live base).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import { lovableAdapter, LOVABLE_FORM_SAMPLE } from "../src/lib/adapters/lovable";
import { ADAPTERS, adapterFor, UNSIGNED_ONLY, isUnsignedOnly } from "../src/lib/adapters";
import { createWebhookEndpoint } from "../src/lib/integrations";
import { createTrackingProject, trackerInstallSnippet } from "../src/lib/tracker";
import { processInbound } from "../src/lib/ingest";

const FIT = "cl_upcurvv"; // the tenancy bootstrap client
const OWNER = "u_owner"; // the tenancy bootstrap user (createdBy FK)

describe("D-21 (1) — the lovable adapter extracts the flat form fields -> record.meta + named props", () => {
  it("the saved sample replays: identity + UTM + fbclid land on NAMED props, custom fields in meta", () => {
    const out = lovableAdapter.parse(LOVABLE_FORM_SAMPLE);
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.platform).toBe("lovable");
    expect(r.type).toBe("registered"); // a Lovable form POST is a lead, never a payment
    expect(r.status).toBe("pending");
    expect(r.phone).toBe("+919812340010");
    expect(r.email).toBe("aarav@example.com");
    expect(r.name).toBe("Aarav Shah");
    expect(r.city).toBe("Ahmedabad");
    expect(r.utmSource).toBe("facebook");
    expect(r.utmMedium).toBe("paid");
    expect(r.utmCampaign).toBe("w1_launch");
    expect(r.fbclid).toBe("PAZXh0_EXAMPLE_FBCLID_0010");
    // The user-named custom field ("course") is NOT a Lead column — it lives
    // in meta so no field is lost (D-19 parity with the Flexi adapter).
    expect(r.meta?.course).toBe("Data Analytics");
    // NAMED fields are consumed — not duplicated into meta:
    expect(r.meta?.phone).toBeUndefined();
    expect(r.meta?.email).toBeUndefined();
    expect(r.meta?.name).toBeUndefined();
  });

  it("an unknown custom field flows into meta, not a named prop (record-level meta, D-19b)", () => {
    const out = lovableAdapter.parse({ ...LOVABLE_FORM_SAMPLE, what_is_your_goal: "Grow MRR" });
    expect(out[0]!.meta?.what_is_your_goal).toBe("Grow MRR");
  });

  it("a bare POST with no identity still parses (a registration with no fields lost — never a crash)", () => {
    const out = lovableAdapter.parse({});
    expect(out).toHaveLength(1);
    expect(out[0]!.platform).toBe("lovable");
    expect(out[0]!.type).toBe("registered");
    expect(out[0]!.phone).toBeNull();
    expect(out[0]!.meta).toBeUndefined(); // nothing to carry
  });
});

describe("D-21 (2) — the [platform] path accepts /api/webhooks/lovable UNSIGNED", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("lovable is registered in the ADAPTERS catalog (the route auto-enumerates it)", () => {
    expect(ADAPTERS.lovable).toBeDefined();
    expect(adapterFor("lovable")).toBe(lovableAdapter);
    expect(ADAPTERS.lovable.label).toBe("Lovable (tracking + form host)");
  });

  it("lovable is UNSIGNED_ONLY: a created connection has secret='' (the D-18 shape)", async () => {
    expect(UNSIGNED_ONLY).toContain("lovable");
    expect(isUnsignedOnly("lovable")).toBe(true);
    const created = await createWebhookEndpoint(db.prisma, {
      clientId: FIT, platform: "lovable", label: "d21-lovable", createdBy: OWNER,
    });
    expect(created.unsigned).toBe(true);
    expect(created.secret).toBe(""); // no generated secret
    // …and the persisted row is empty too (not just the return value):
    const row = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.endpointSecret).toBe("");
    // The inboundUrl is the lovable endpoint (the PO's fetch() target):
    expect(row.inboundUrl).toContain("/api/webhooks/lovable?client=" + FIT + "&conn=");
  });

  it("an empty-secret Lovable POST (no secret header) → a real lead lands (like D-18 flexifunnels)", async () => {
    // The PO's hand-wired Lovable fetch(): a bare JSON form body, no
    // x-webhook-secret header (Lovable has none to send), the unsigned
    // connection secret = "".
    const ep = await createWebhookEndpoint(db.prisma, {
      clientId: FIT, platform: "lovable", label: "d21-unsigned", createdBy: OWNER,
    });
    expect(ep.unsigned).toBe(true);
    expect(ep.secret).toBe("");

    const res = await processInbound({
      prisma: db.prisma,
      clientId: FIT,
      platform: "lovable",
      clientSecret: ep.secret, // "" — the unsigned D-18/D-21 shape
      rawBody: JSON.stringify(LOVABLE_FORM_SAMPLE),
      headers: { "content-type": "application/json", rawBody: JSON.stringify(LOVABLE_FORM_SAMPLE) },
    });
    expect(res.status).toBe("processed");
    expect(res.payments).toBe(0);
    expect(res.events).toBe(1);
    expect(res.leadIds).toHaveLength(1);
    const lead = await db.prisma.lead.findFirst({ where: { id: res.leadIds[0]! } });
    expect(lead?.email).toBe("aarav@example.com");
    expect(lead?.name).toBe("Aarav Shah");
  });
});

describe("D-21 (3) — a Lovable tracking project generates the correct tracker.js snippet", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("createTrackingProject + trackerInstallSnippet → a data-project=<id> script the PO pastes into the Lovable app head", async () => {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    const created = await createTrackingProject(db.prisma, {
      workspaceId: ws.id,
      name: "lovable-landing-w1",
      landingPageName: "Lovable W1 landing",
      landingPageUrl: "https://w1.lovable.app",
      clientId: FIT,
      createdBy: OWNER,
    });
    const BASE = "https://live-host.example.com";
    const snippet = trackerInstallSnippet(created.id, BASE);
    // The exact shape Device Track's D-17 install uses — reused, NOT a second
    // tracker (the ticket: "reuse the existing tracker.js").
    expect(snippet).toBe(`<script src="${BASE}/tracker.js"\n  data-project="${created.id}"\n  data-api="${BASE}"\n  defer></script>`);
    expect(snippet).toContain(`data-project="${created.id}"`);
    expect(snippet).toContain(`${BASE}/tracker.js`);
    // And the created project is a real row (the PO's Device Track screen shows it):
    const stored = await db.prisma.trackingProject.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.name).toBe("lovable-landing-w1");
    expect(stored.landingPageUrl).toBe("https://w1.lovable.app");
    expect(stored.clientId).toBe(FIT);
  });
});
