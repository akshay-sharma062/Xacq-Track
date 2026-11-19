/**
 * D-18 — secret-free (unsigned) webhook connections for header-less platforms.
 *
 * FlexiFunnels (and Cosmofeed + TagMango) CANNOT send a signature / secret
 * header — FlexiFunnels support confirmed it only POSTs to a bare URL. So a
 * per-CONNECTION secret on any of them can never be echoed back:
 * makeSimpleGatewayAdapter.verify does `if (!secret) return true; else
 * headers["x-webhook-secret"] === secret` → with a stored secret and an
 * undefined header, EVERY real POST fails "verification failed" (the exact PO
 * symptom). D-18 makes these platforms run UNSIGNED (endpointSecret = "").
 *
 * Proven at the repo's test boundary (the framework-free lib layer + source
 * contract asserts, per the D-12/D-15 precedent):
 *   (a) an UNSIGNED_ONLY connection is created with an EMPTY secret by default;
 *   (b) verify() accepts a plain POST (no x-webhook-secret header) when the
 *       connection secret is empty;
 *   (c) a SIGNED platform (razorpay) still REJECTS a wrong/missing signature
 *       (no security regression — D-18 loosens ONLY the header-less platforms);
 *   (d) the "clear secret" action empties the stored secret (idempotent; a
 *       signed platform is refused);
 *   (e) a re-sent FlexiFunnels POST now lands "processed/ok" not
 *       "verification failed" (the conn-log status flips failed → ok).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { freshDb, TestDb } from "./helpers";
import {
  createWebhookEndpoint,
  clearWebhookEndpointSecret,
  clearUnsignedWebhookSecrets,
  mapConnStatus,
} from "../src/lib/integrations";
import { UNSIGNED_ONLY, isUnsignedOnly, adapterFor } from "../src/lib/adapters";
import { flexifunnelsAdapter, razorpayAdapter } from "../src/lib/adapters/payments";
import { processInbound } from "../src/lib/ingest";

const FIT = "cl_upcurvv"; // the tenancy bootstrap client
const OWNER = "u_owner"; // the tenancy bootstrap user (createdBy FK)

const hmac = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

/** Simulate a pre-D-18 row that still carries a generated secret (the PO's
 *  broken FlexiFunnels connection): empty the row's secret back to a value. */
async function plantLeftoverSecret(p: PrismaClient, endpointId: string, secret: string) {
  await p.webhookEndpoint.update({ where: { id: endpointId }, data: { endpointSecret: secret } });
}

describe("D-18 (a) — an UNSIGNED_ONLY connection is created with an EMPTY secret by default", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it.each(UNSIGNED_ONLY.map((p) => [p] as const))("platform %s creates with secret='' + unsigned:true", async (platform) => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform, label: "d18-gen", createdBy: OWNER });
    expect(ep.unsigned).toBe(true);
    expect(ep.secret).toBe(""); // no generated secret
    // …and the persisted row is empty too (not just the return value):
    const row = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    expect(row.endpointSecret).toBe("");
  });

  it("a SIGNED-CAPABLE platform still gets a generated secret (unchanged behaviour)", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d18-sig", createdBy: OWNER });
    expect(ep.unsigned).toBe(false);
    expect(ep.secret).toHaveLength(44); // 32 random bytes, base64
    expect(ep.secret).not.toBe("");
  });
});

describe("D-18 (b) — verify() accepts a plain POST (no secret header) when the connection secret is empty", () => {
  it("the flexifunnels adapter verify() returns true for an empty secret with NO header present", () => {
    const sample = flexifunnelsAdapter.sample;
    const v = flexifunnelsAdapter.verify as (p: unknown, h: Record<string, string>, s: string | null) => boolean;
    // A real FlexiFunnels POST: bare JSON body, the provider sends NO
    // x-webhook-secret header (it can't). An empty connection secret must
    // therefore ACCEPT — the exact pre-D-18 failure inverted.
    expect(v(sample, { rawBody: JSON.stringify(sample) }, "")).toBe(true);
    expect(v(sample, {}, null)).toBe(true); // null secret (dev unsigned default) too
  });

  it("an empty secret is also what makeSimpleGatewayAdapter treats as unsigned for the sibling header-less adapters", () => {
    // The three UNSIGNED_ONLY adapters share the same verify shape — an empty
    // secret is accepted by all of them (no header required).
    for (const p of UNSIGNED_ONLY) {
      const ad = adapterFor(p);
      // cosmofeed/tagmango use the x-webhook-secret verify; flexifunnels too.
      expect(ad.verify!(ad.sample, {}, "")).toBe(true);
    }
  });
});

describe("D-18 (c) — a SIGNED platform (razorpay) still REJECTS a wrong / missing secret (no regression)", () => {
  const sample = razorpayAdapter.sample;
  const body = JSON.stringify(sample);
  const v = razorpayAdapter.verify as (p: unknown, h: Record<string, string>, s: string | null) => boolean;
  const SECRET = "razorpay_webhook_secret";

  it("accepts the CORRECT HMAC signature", () => {
    expect(v(sample, { "x-razorpay-signature": hmac(SECRET, body), rawBody: body }, SECRET)).toBe(true);
  });
  it("rejects a MISSING signature header (an unauthenticated POST)", () => {
    expect(v(sample, { rawBody: body }, SECRET)).toBe(false);
  });
  it("rejects a WRONG signature (a different / attacker secret)", () => {
    expect(v(sample, { "x-razorpay-signature": hmac("attacker_secret", body), rawBody: body }, SECRET)).toBe(false);
    // And an attacker who does NOT know the secret cannot forge one:
    expect(v(sample, { "x-razorpay-signature": "deadbeef", rawBody: body }, SECRET)).toBe(false);
  });
  it("the signed platform is NOT in the UNSIGNED_ONLY set (the guardrail)", () => {
    expect(isUnsignedOnly("razorpay")).toBe(false);
    expect(UNSIGNED_ONLY).not.toContain("razorpay");
  });
});

describe("D-18 (d) — the 'clear secret' action empties the stored secret (idempotent; signed refused)", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("empties a header-less platform's leftover secret; re-clear is an idempotent no-op", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d18-leftover", createdBy: OWNER });
    // Simulate a pre-D-18 row that still carries a generated secret:
    await plantLeftoverSecret(db.prisma, ep.id, "old_secret_should_be_gone");
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).endpointSecret).toBe("old_secret_should_be_gone");

    expect(await clearWebhookEndpointSecret(db.prisma, ep.id)).toEqual({ cleared: true });
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).endpointSecret).toBe("");

    // Idempotent: clearing an already-unsigned row reports no-op, not an error:
    expect(await clearWebhookEndpointSecret(db.prisma, ep.id)).toEqual({ cleared: true, alreadyUnsigned: true });
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } })).endpointSecret).toBe("");
  });

  it("REFUSES to clear a SIGNED-capable platform's secret (the D-18 guardrail)", async () => {
    const rzp = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d18-sig2", createdBy: OWNER });
    expect(rzp.secret).not.toBe(""); // a signed secret to protect
    const before = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rzp.id } });
    expect(await clearWebhookEndpointSecret(db.prisma, rzp.id)).toEqual({ cleared: false, signedPlatform: true });
    // The secret is UNCHANGED — an unauthenticated POST path was NOT opened:
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rzp.id } })).endpointSecret).toBe(before.endpointSecret);
  });

  it("clearUnsignedWebhookSecrets (the one-off script path) clears UNSIGNED_ONLY rows and SKIPS signed rows, idempotently", async () => {
    const ff = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d18-mass-ff", createdBy: OWNER });
    const rzp = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "razorpay", label: "d18-mass-rzp", createdBy: OWNER });
    // Simulate pre-D-18 leftovers on BOTH rows:
    await plantLeftoverSecret(db.prisma, ff.id, "ff_old");
    await plantLeftoverSecret(db.prisma, rzp.id, "rzp_old");

    const r1 = await clearUnsignedWebhookSecrets(db.prisma);
    expect(r1.cleared).toBe(1); // only the flexifunnels row (unsigned-capable)
    expect(r1.skippedSigned).toBe(1); // the razorpay row is protected
    expect(r1.rows.find((x) => x.id === ff.id)?.changed).toBe(true);
    expect(r1.rows.find((x) => x.id === rzp.id)?.changed).toBe(false);
    // The unsigned row is now empty; the signed row KEEPS its secret:
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ff.id } })).endpointSecret).toBe("");
    expect((await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: rzp.id } })).endpointSecret).toBe("rzp_old");

    // Idempotent: a second run changes 0, already=1, skipped=1:
    const r2 = await clearUnsignedWebhookSecrets(db.prisma);
    expect(r2.cleared).toBe(0);
    expect(r2.already).toBe(1);
    expect(r2.skippedSigned).toBe(1);
  });
});

describe("D-18 (e) — a re-sent FlexiFunnels POST with the CLEARED connection logs 'processed/ok', not 'verification failed'", () => {
  let db: TestDb;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await db.close();
  });

  it("before the clear (leftover secret, no header) → 'verification failed'; after the clear (empty secret) → 'ok'", async () => {
    const ep = await createWebhookEndpoint(db.prisma, { clientId: FIT, platform: "flexifunnels", label: "d18-fix", createdBy: OWNER });
    await plantLeftoverSecret(db.prisma, ep.id, "leftover_secret");
    const sample = flexifunnelsAdapter.sample;
    const rawBody = JSON.stringify(sample);

    // BEFORE: the connection still carries a secret, but FlexiFunnels can't
    // send the x-webhook-secret header → verify() fails → 'verification failed'.
    const before = await processInbound({
      prisma: db.prisma, clientId: FIT, platform: "flexifunnels",
      clientSecret: "leftover_secret", rawBody, headers: { rawBody, "content-type": "application/json" },
    });
    expect(before.status).toBe("failed");
    expect(before.error).toBe("verification failed");
    expect(mapConnStatus(before.status)).toBe("failed"); // → conn-log row would be 'failed'

    // THE FIX: clear the leftover secret (what scripts/unsigned-flexi.ts does):
    expect((await clearWebhookEndpointSecret(db.prisma, ep.id)).cleared).toBe(true);
    const clearedRow = await db.prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
    expect(clearedRow.endpointSecret).toBe("");

    // AFTER: the same POST, now verified against the CLEARED (empty) secret →
    // accepted unsigned → 'processed' → the conn-log row is 'ok', not 'failed'.
    const after = await processInbound({
      prisma: db.prisma, clientId: FIT, platform: "flexifunnels",
      clientSecret: clearedRow.endpointSecret, rawBody, headers: { rawBody, "content-type": "application/json" },
    });
    expect(after.status).toBe("processed");
    expect(after.error).toBeUndefined();
    expect(mapConnStatus(after.status)).toBe("ok"); // ← 'processed/ok', not 'verification failed'
    // D-19 repoint: the shared flexifunnels sample is now the REAL optin
    // lead-capture shape (a registration, NOT a payment), so a real LEAD lands
    // through the unsigned path with full identity (0 payments, 1 event, 1 lead).
    expect(after.payments).toBe(0);
    expect(after.events).toBe(1);
    expect(after.leadIds).toHaveLength(1);
    const lead = await db.prisma.lead.findFirst({ where: { id: after.leadIds[0] } });
    expect(lead?.phone).toBe("+919812340005"); // raw value the adapter hands through
    expect(lead?.email).toBe("priya.optin@example.com");
    expect(lead?.name).toBe("Priya");
  });
});
