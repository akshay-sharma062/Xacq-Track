/**
 * D-14 — client + admin details that were missing from the app (display gap,
 * read-only). Two additions:
 *
 *   A. CLIENT PROFILE BAND on the dashboard (single-client view): `clientProfile`
 *      in src/lib/dashboard.ts reads the Client row + workspace + funnel/lead
 *      counts for the compact "Client profile" card. SECURITY GUARDRAIL: the
 *      reader is a WHITELIST select — `Client.webhookSecret` and the D-13
 *      secrets (ApiKey/WebhookEndpoint) are structurally excluded, so no
 *      secret can reach the UI.
 *
 *   B. ACTING USER / ADMIN DETAILS in the Topbar: GET /api/session gains two
 *      ADDITIVE fields (workspace name + twoFactor); the Topbar surfaces the
 *      acting user's email, workspace, and the phone-mask STATE ("phones:
 *      masked/visible"). PII guardrail: a full phone value is never part of
 *      the session payload — only the mask flag; lead phones still go through
 *      maskPhone() (a masked role sees only the last-4, locked in below).
 *
 * Verified here: clientProfile returns the real fields and NEVER a secret
 * column; the session route returns the new fields WITHOUT breaking the
 * existing payload; maskPhone gives a masked role the last-4 only; and the
 * dashboard/Topbar/session source never renders or selects a secret value
 * (the ticket's grep proof, pinned as a contract so it can't regress).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { freshDb, TestDb } from "./helpers";
import { clientProfile } from "../src/lib/dashboard";
import { maskPhone, Session } from "../src/lib/session";

// House style (D-12 precedent): route/page contracts are pinned as source
// asserts against the exact files, so a regression that renders a secret or
// drops the acting-user fields breaks the suite.
const PAGE = readFileSync("src/app/page.tsx", "utf8");
const TOPBAR = readFileSync("src/app/components/Topbar.tsx", "utf8");
const SESSION_ROUTE = readFileSync("src/app/api/session/route.ts", "utf8");
// The clientProfile FUNCTION body (from its signature to EOF) — the
// whitelist SELECT lives here. Sliced at the signature on purpose: the
// doc-comment directly above it NAMES the excluded secret columns to document
// the guardrail, and we do NOT want that prose to false-positive the
// "no secret column is selected" grep below. Only the real code is in scope.
const DASH_SRC = readFileSync("src/lib/dashboard.ts", "utf8");
const CLIENT_PROFILE_SRC = DASH_SRC.slice(DASH_SRC.indexOf("export async function clientProfile"));

// ---------------------------------------------------------------------------
// A — clientProfile: the real display fields, structurally secret-free.
// ---------------------------------------------------------------------------

describe("D-14 clientProfile — reads the client's real fields, never a secret column", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  async function seedProfileClient() {
    const ws = await db.prisma.workspace.findFirstOrThrow();
    const client = await db.prisma.client.create({
      data: {
        id: "cl_d14",
        workspaceId: ws.id,
        name: "D-14 Client",
        currency: "INR",
        timezone: "Asia/Kolkata",
        offerPrice: 4999,
        attributionWindowDays: 14,
        attributionModel: "first_click",
        // A secret IS set on the row — the reader must simply NOT return it:
        webhookSecret: "whsec_d14_never_rendered",
        metaPageId: "pg_d14",
        metaPixelId: "1234567890",
        capiEventType: "default",
      },
    });
    await db.prisma.funnel.createMany({
      data: [
        { id: "f_d14_1", clientId: client.id, type: "webinar", name: "W1", landingUrls: "[]", productIds: "[]", stages: "[]" },
        { id: "f_d14_2", clientId: client.id, type: "direct_checkout", name: "DC", landingUrls: "[]", productIds: "[]", stages: "[]" },
      ],
    });
    await db.prisma.lead.createMany({
      data: [
        { id: "l_d14_1", clientId: client.id, phone: "+919812340001", phoneNormalized: "+919812340001", email: "a@x.com", emailNormalized: "a@x.com" },
        { id: "l_d14_2", clientId: client.id, phone: "+919812340002", phoneNormalized: "+919812340002", email: "b@x.com", emailNormalized: "b@x.com" },
        { id: "l_d14_3", clientId: client.id, phone: "+919812340003", phoneNormalized: "+919812340003", email: "c@x.com", emailNormalized: "c@x.com" },
      ],
    });
    return client;
  }

  it("returns the ticket's display fields from the real row (offer/attribution/meta config/counts)", async () => {
    const c = await seedProfileClient();
    const p = await clientProfile(db.prisma, c.id);
    expect(p?.name).toBe("D-14 Client");
    expect(p?.currency).toBe("INR");
    expect(p?.offerPrice).toBe(4999);
    expect(p?.attributionWindowDays).toBe(14);
    expect(p?.attributionModel).toBe("first_click");
    expect(p?.timezone).toBe("Asia/Kolkata");
    expect(p?.metaPageId).toBe("pg_d14"); // config value — shown
    expect(p?.metaPixelId).toBe("1234567890"); // config value — shown
    expect(p?.capiEventType).toBe("default");
    expect(p?.workspaceName).toBeTruthy(); // the client's workspace name
    expect(p?.funnelCount).toBe(2);
    expect(p?.leadCount).toBe(3);
    expect(p?.updatedAt).toBeInstanceOf(Date);
  });

  it("NEVER returns the client's webhook secret — even though one is set on the row", async () => {
    const c = await seedProfileClient();
    const p = await clientProfile(db.prisma, c.id);
    // The shape has no place to put it:
    expect(Object.keys(p!)).not.toContain("webhookSecret");
    // …and the rendered field set is exactly the ticket's whitelist (no D-13 secrets):
    for (const banned of ["webhookSecret", "endpointSecret", "keyHash", "secret"]) {
      expect(Object.keys(p!)).not.toContain(banned);
    }
  });

  it("an unknown client id → null (the band simply does not render)", async () => {
    expect(await clientProfile(db.prisma, "cl_does_not_exist")).toBeNull();
  });

  it("the clientProfile SELECT in dashboard.ts structurally excludes every secret column (grep proof)", () => {
    expect(CLIENT_PROFILE_SRC).toMatch(/clientProfile/);
    expect(CLIENT_PROFILE_SRC).toMatch(/metaPixelId: true/); // the config fields ARE selected
    // No secret column is selected anywhere in the reader:
    expect(CLIENT_PROFILE_SRC).not.toMatch(/webhookSecret/);
    expect(CLIENT_PROFILE_SRC).not.toMatch(/endpointSecret/);
    expect(CLIENT_PROFILE_SRC).not.toMatch(/keyHash/);
  });
});

// ---------------------------------------------------------------------------
// B-1 — the session route returns the new additive fields.
// ---------------------------------------------------------------------------

describe("D-14 /api/session — gains workspace + twoFactor without breaking the existing payload", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
    // The route resolves the acting user from the DEMO_USER env (no cookie in
    // a test) → the bootstrap owner.
    process.env.DEMO_USER = "arpit@foremostleads.in";
    // The route (via src/lib/prisma) caches a GLOBAL singleton prisma client
    // keyed to the DATABASE_URL at FIRST IMPORT. Each freshDb() points at a
    // NEW throwaway DB, so drop every cached module + the singleton itself
    // before re-importing the route for this test.
    vi.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).globalPrisma = undefined;
  });
  afterEach(async () => {
    delete process.env.DEMO_USER;
    await db.close();
  });

  it("GET returns the new fields (workspace name + twoFactor) on the acting session", async () => {
    const route = await import("../src/app/api/session/route");
    const res = await route.GET();
    const j = await res.json();

    // D-14 additive fields:
    expect(j.session.workspace).toBe("Foremost Leads"); // the bootstrap workspace name
    expect(j.session.twoFactor).toBe(true); // the bootstrap owner has 2FA on

    // The EXISTING payload is intact (additive, not a break):
    expect(j.session.email).toBe("arpit@foremostleads.in");
    expect(j.session.name).toBe("Arpit Sharma");
    expect(j.session.role).toBe("owner");
    expect(j.session.maskPhone).toBe(false);
    expect(Array.isArray(j.session.clientIds)).toBe(true);
    for (const k of ["clients", "adAccounts", "personas", "roles"]) expect(k in j).toBe(true);
  });

  it("a session payload never carries a phone VALUE — only the mask STATE flag", async () => {
    const route = await import("../src/app/api/session/route");
    const res = await route.GET();
    const j = await res.json();
    expect(j.session).not.toHaveProperty("phone");
    expect(j.session).not.toHaveProperty("fullPhone");
    // maskPhone STATE is present (the Topbar's "phones: masked/visible" flag):
    expect(j.session).toHaveProperty("maskPhone");
  });
});

// ---------------------------------------------------------------------------
// B-2 — PII guardrail: a masked role sees only the last-4 (maskPhone lock-in).
// ---------------------------------------------------------------------------

describe("D-14 PII guardrail — maskPhone gives a masked role the last-4, not the full phone", () => {
  const full = "+919812340099";
  const masked = { maskPhone: true } as unknown as Session;
  const visible = { maskPhone: false } as unknown as Session;

  it("a masked role sees the last-4 (•-padded) and NEVER the full digits", () => {
    const out = maskPhone(full, masked);
    expect(out.endsWith("0099")).toBe(true); // last-4 present
    expect(out).not.toContain(full); // full phone not in the output
    expect(out).not.toContain("9812340099"); // and not the raw 10-digit form either
  });

  it("a role that may see phones gets the full value (unchanged behaviour)", () => {
    expect(maskPhone(full, visible)).toBe(full);
  });

  it("an empty phone → empty string (no fake data)", () => {
    expect(maskPhone(null, masked)).toBe("");
    expect(maskPhone(undefined, masked)).toBe("");
    expect(maskPhone("", visible)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// UI contract — the band + Topbar render the fields; no secret ever renders.
// ---------------------------------------------------------------------------

describe("D-14 dashboard band + Topbar — render the new details, never a secret value", () => {
  it("the dashboard reads clientProfile ONLY in the single-client view and renders the band + the all-clients summary", () => {
    expect(PAGE).toMatch(/clientProfile\(prisma, clientIds\[0\]\)/); // single-client drill
    expect(PAGE).toMatch(/profile \? \(/); // the band is conditional on the profile
    expect(PAGE).toMatch(/Client profile/); // the card title
    expect(PAGE).toMatch(/clients in this view/); // the all-clients summary line
    // Fields actually rendered:
    for (const f of ["profile.offerPrice", "profile.attributionModel", "profile.timezone", "profile.metaPageId", "profile.metaPixelId", "profile.capiEventType", "profile.funnelCount", "profile.leadCount", "profile.workspaceName"]) {
      expect(PAGE, `field ${f} not rendered`).toContain(f);
    }
    // The page NEVER references a secret column:
    for (const banned of ["webhookSecret", "endpointSecret", "keyHash"]) expect(PAGE).not.toContain(banned);
  });

  it("the Topbar surfaces the acting user's email + workspace + phone-mask STATE (compact, additive)", () => {
    expect(TOPBAR).toMatch(/me\.email/);
    expect(TOPBAR).toMatch(/me\.workspace/);
    expect(TOPBAR).toMatch(/phones: \{me\.maskPhone \? "masked" : "visible"\}/);
    // The mask STATE only — no phone VALUE anywhere in the Topbar:
    expect(TOPBAR).not.toContain("me?.phone");
    expect(TOPBAR).not.toMatch(/phone[=:]\s*["']?\+?\d/);
  });

  it("the session route selects ONLY display config from the acting user (no secret fields in the payload)", () => {
    expect(SESSION_ROUTE).toMatch(/twoFactor: true, workspace: \{ select: \{ name: true \} \}/);
    expect(SESSION_ROUTE).toMatch(/twoFactor: acting\?\.twoFactor/);
    // No secret column is ever selected/read by the route:
    for (const banned of ["webhookSecret", "endpointSecret", "keyHash"]) expect(SESSION_ROUTE).not.toContain(banned);
    // No phone VALUE is carried either: `phoneMask` (the mask STATE flag, which
    // the Topbar shows as "phones: masked/visible") is legitimate and stays —
    // but no phone column is SELECTED anywhere in the route.
    expect(SESSION_ROUTE).toMatch(/phoneMask: true/); // the state flag (personas select)
    expect(SESSION_ROUTE).not.toMatch(/phone: true/); // no phone VALUE column selected
    expect(SESSION_ROUTE).not.toMatch(/phoneNormalized/);
  });
});
