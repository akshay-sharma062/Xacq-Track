/**
 * G8 — CAPI LIVE path (spec 5.8): real Conversions API send + EMQ read-back,
 * with Meta's HTTP mocked (no real network in tests). Covers:
 *   - live 200 read-back (fbtrace_id + event_match_quality persisted, EMQ from Meta wins)
 *   - 4xx BLOCKED (exact Meta error string, never a canned success)
 *   - dedup regression (a second run is a no-op for already-sent rows — never sent twice)
 *   - refund-guard regression (a Refund row / a Lost-stage Purchase is never POSTed)
 *   - simulate honesty (no token or no pixel -> local mark, no network, simulated=true)
 *   - wire format (Meta's real user_data keys: client_ip_address / client_user_agent;
 *     frozen event_id = capiWireEventId(stored dedupKey))
 */
import { describe, it, expect } from "vitest";
import { freshDb } from "./helpers";
import { sendQueue, postOneCapiEvent } from "../src/lib/meta/capi";
import { buildCapiEvent, capiDedupKey, capiWireEventId, toMetaWireEvent } from "../src/lib/capi";
import { hashPhoneForCapi, hashEmailForCapi } from "../src/lib/hash";

const CLIENT = "cl_upcurvv"; // the tenancy bootstrap client

interface MetaCall { url: string; init: { body: string; method: string } }

/** A Meta-shaped fetch mock: records calls, returns canned responses. */
function mockMeta(fetchCalls: MetaCall[], responder: (n: number) => { ok: boolean; status: number; body: unknown }) {
  return async (url: any, init: any) => {
    fetchCalls.push({ url: String(url), init });
    const r = responder(fetchCalls.length - 1);
    const json = JSON.stringify(r.body);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => JSON.parse(json),
      text: async () => json,
    } as unknown as Response;
  };
}

async function seedPurchaseRow() {
  const { prisma, close } = await freshDb();
  const lead = await prisma.lead.create({
    data: { clientId: CLIENT, phone: "+919812340099", phoneNormalized: "+919812340099", email: "g8lead@x.com", emailNormalized: "g8lead@x.com" },
  });
  const dedupKey = capiDedupKey("Purchase", { clientId: CLIENT, leadId: lead.id, phone: lead.phone, email: lead.email }, "rzp_g8_1");
  const row = await prisma.outboundEvent.create({
    data: {
      clientId: CLIENT,
      leadId: lead.id,
      type: "Purchase",
      value: 4999,
      currency: "INR",
      fbc: "fb.g8",
      fbp: "g8-fbp",
      hashedPhone: hashPhoneForCapi("+919812340099"),
      hashedEmail: hashEmailForCapi("g8lead@x.com"),
      clientIp: "10.0.0.9",
      userAgent: "g8-live-test/1.0",
      eventTime: new Date("2026-11-03T10:00:00Z"),
      eventId: dedupKey,
      dedupKey,
      status: "queued",
      matchQuality: 7, // local estimate at enqueue — Meta's number must win when reported
    },
  });
  return { prisma, lead, row, close };
}

describe("G8 CAPI LIVE — mocked Meta HTTP (no real network in tests)", () => {
  it("live 200: persists Meta's ack id + EMQ (Meta-reported wins over the local estimate)", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000001",
      eventSourceUrl: "https://upcurvv.com/w1", // D-11: a live POST requires a web source URL
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_1", event_hub_log_view: [{ event_id: "eid_1", event_match_quality: 9 }] } })) as unknown as typeof fetch,
    });

    expect(out.live).toBe(1);
    expect(out.sent).toBe(1);
    expect(out.failed).toBe(0);
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.sentToMeta).toBe(true);
    expect(got.simulated).toBe(false);
    expect(got.metaAckId).toBe("fbt_1"); // Meta's returned event id (ack)
    expect(got.metaEmq).toBe("9"); // verbatim
    expect(got.emqFromMeta).toBe(true);
    expect(got.matchQuality).toBe(9); // Meta's number, NOT the local 7
    expect(got.pixelUsed).toBe("1000000000000001");
    await close();
  });

  it("live wire format: Meta's real user_data keys + frozen event_id + value/currency", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000002",
      eventSourceUrl: "https://upcurvv.com/w1", // D-11: the live path requires a web source URL
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_w" } })) as unknown as typeof fetch,
    });
    const req = JSON.parse(String(calls[0].init.body)) as { data: Record<string, unknown>[] };
    const ev = req.data[0];
    expect(ev.action_type).toBe("Purchase");
    expect(ev.event_name).toBe("PURCHASE"); // Meta's required event_name (standard name)
    expect(ev.event_id).toBe(capiWireEventId(row.dedupKey)); // frozen from the stored dedupKey
    // D-11: with a source URL the event is a WEB source — "website" +
    // event_source_url, and the web user_data signals (ip/ua) are kept.
    expect(ev.action_source).toBe("website");
    expect(ev.event_source_url).toBe("https://upcurvv.com/w1");
    const ud = ev.user_data as Record<string, unknown>;
    expect(ud.client_ip_address).toBe("10.0.0.9");
    expect(ud.client_user_agent).toBe("g8-live-test/1.0");
    expect(ud).toMatchObject({ fbc: "fb.g8", fbp: "g8-fbp" });
    expect(ud.ph).toBe(hashPhoneForCapi("+919812340099"));
    expect(ud.em).toBe(hashEmailForCapi("g8lead@x.com"));
    expect(ev.custom_data).toEqual({ value: 4999, currency_code: "INR" }); // Meta's custom_data field name
    expect(String(calls[0].url)).toContain("/1000000000000002/events");
    await close();
  });

  it("4xx BLOCKED: records the EXACT Meta error string, never a canned success", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000003",
      eventSourceUrl: "https://upcurvv.com/w1", // reach the live/POST path (BLOCKED on Meta's 4xx)
      fetch: mockMeta([], () => ({ ok: false, status: 403, body: { error: { message: "Unsupported post request. Object with ID '1000000000000003' does not exist." } } })) as unknown as typeof fetch,
    });
    expect(out.failed).toBe(1);
    expect(out.live).toBe(0);
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("failed");
    expect(got.simulated).toBe(false);
    expect(got.sentToMeta).toBe(false); // not sent
    expect(got.error).toContain("403");
    expect(got.error).toContain("Unsupported post request"); // exact Meta string, for the BLOCKED record
    expect(got.metaAckId).toBeNull();
    expect(got.emqFromMeta).toBe(false);
    await close();
  });

  it("dedup regression: re-running the queue is a no-op for already-sent rows (never sent twice)", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    // First run: send it live.
    await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000004",
      eventSourceUrl: "https://upcurvv.com/w1", // D-11: live path requires the web source URL
      fetch: mockMeta([], () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_d" } })) as unknown as typeof fetch,
    });
    // Second run with a fresh counting spy: zero fetch calls, row unchanged.
    const calls: MetaCall[] = [];
    const out2 = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000004",
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_d2" } })) as unknown as typeof fetch,
    });
    expect(out2.total).toBe(0); // the sent row is no longer in queued/failed
    expect(calls).toHaveLength(0); // nothing re-POSTed
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    await close();
  });

  it("refund-guard regression: a Refund row is never POSTed (skipped note, not a send)", async () => {
    const { prisma, row, close } = await (async () => {
      const db = await freshDb();
      const lead = await db.prisma.lead.create({ data: { clientId: CLIENT, phone: "+919812340088", phoneNormalized: "+919812340088", email: "g8ref@x.com" } });
      const dk = capiDedupKey("Refund", { clientId: CLIENT, leadId: lead.id, phone: lead.phone }, "cf_ref_1");
      const created = await db.prisma.outboundEvent.create({
        data: { clientId: CLIENT, leadId: lead.id, type: "Refund", value: 4999, hashedPhone: hashPhoneForCapi("+919812340088"), eventTime: new Date(), eventId: dk, dedupKey: dk, status: "queued" },
      });
      return { prisma: db.prisma, row: created, close: db.close };
    })();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000005",
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(out.skipped).toBe(1);
    expect(calls).toHaveLength(0); // fetch never called for the refund
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("skipped");
    expect(got.sentToMeta).toBe(false);
    await close();
  });

  it("simulate honesty: no pixel -> local mark, no network, simulated=true (never a fake live-success)", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: null, // no pixel for this client -> simulate
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(out.simulated).toBe(1);
    expect(out.live).toBe(0);
    expect(calls).toHaveLength(0); // no network
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.simulated).toBe(true);
    expect(got.sentToMeta).toBe(false); // not actually sent to Meta
    expect(got.emqFromMeta).toBe(false);
    await close();
  });

  it("simulate honesty: no token -> simulate even when a pixel is present", async () => {
    const { prisma, close } = await (async () => {
      const db = await freshDb();
      // A lead-linked Lead row with an identity (so the send-guard passes and
      // the simulate branch — not a "no identity" skip — is what runs).
      const lead = await db.prisma.lead.create({ data: { clientId: CLIENT, phone: "+919812340077", phoneNormalized: "+919812340077", email: "g8lead2@x.com" } });
      const dk = capiDedupKey("Lead", { clientId: CLIENT, leadId: lead.id, phone: lead.phone }, "g8lead2");
      await db.prisma.outboundEvent.create({
        data: { clientId: CLIENT, leadId: lead.id, type: "Lead", value: null, hashedPhone: hashPhoneForCapi("+919812340077"), eventTime: new Date(), eventId: dk, dedupKey: dk, status: "queued" },
      });
      return { prisma: db.prisma, close: db.close };
    })();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "", // no token -> simulate
      metaPixelId: "1000000000000006",
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(out.simulated).toBe(1);
    expect(out.skipped).toBe(0);
    expect(calls).toHaveLength(0);
    const got = await prisma.outboundEvent.findFirst({ where: { clientId: CLIENT } });
    expect(got?.simulated).toBe(true);
    expect(got?.status).toBe("sent");
    expect(got?.sentToMeta).toBe(false); // not actually sent to Meta
    await close();
  });
});

describe("G8 CAPI LIVE — toMetaWireEvent + normalizeMetaEmq pure helpers", () => {
  it("maps the internal envelope to Meta's flat wire format", () => {
    const ev = buildCapiEvent({
      kind: "Purchase",
      identity: { clientId: CLIENT, leadId: "l", phone: "+919812340001", email: "a@b.com" },
      value: 100,
      currency: "INR",
      eventTimeIso: "2026-11-03T00:00:00Z",
      pixelId: "1000000000000008",
      clientIp: "1.2.3.4",
      userAgent: "ua",
    });
    const wire = toMetaWireEvent(ev, capiWireEventId("Purchase:" + CLIENT));
    expect(wire.action_type).toBe("Purchase");
    expect(wire.event_name).toBe("PURCHASE"); // Meta's required standard event name
    // Server-emitted, no source URL: action_source stays "system" and NO
    // event_source_url is set. (Meta's live 400 rejected "system_engine"; see D-07.)
    expect(wire.action_source).toBe("system");
    expect("event_source" in wire).toBe(false); // internal label no longer leaks to the wire
    expect("event_source_url" in wire).toBe(false); // no source URL → no source-url field
    // D-11: on a non-web ("system") source the WEB-only user_data signals are
    // OMITTED (Meta 400s them — subcode 2804039 "...such as 'website'"); the
    // identity match signals (ph/em/fbc/fbp) remain.
    expect((wire.user_data as Record<string, unknown>).client_ip_address).toBeUndefined();
    expect((wire.user_data as Record<string, unknown>).client_user_agent).toBeUndefined();
    expect((wire.user_data as Record<string, unknown>).ph).toBeDefined();
    expect((wire.user_data as Record<string, unknown>).em).toBeDefined();
    expect(wire.event_id).toBe(capiWireEventId("Purchase:" + CLIENT)); // frozen
  });

  it("D-11: a web-source wire event KEEPS the web signals (ip/ua) alongside event_source_url", () => {
    const ev = buildCapiEvent({
      kind: "Purchase",
      identity: { clientId: CLIENT, leadId: "l", phone: "+919812340001", email: "a@b.com" },
      value: 100,
      currency: "INR",
      eventTimeIso: "2026-11-03T00:00:00Z",
      pixelId: "1000000000000008",
      clientIp: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      eventSourceUrl: "https://upcurvv.com/w1",
    });
    const wire = toMetaWireEvent(ev);
    expect(wire.action_source).toBe("website");
    const ud = wire.user_data as Record<string, unknown>;
    expect(ud.client_ip_address).toBe("1.2.3.4"); // web signals kept on the web source
    expect(ud.client_user_agent).toBe("Mozilla/5.0");
  });

  it("web-source wire: a source URL flips action_source to 'website' and adds event_source_url", () => {
    const ev = buildCapiEvent({
      kind: "Purchase",
      identity: { clientId: CLIENT, leadId: "l", phone: "+919812340001", email: "a@b.com" },
      value: 100,
      currency: "INR",
      eventTimeIso: "2026-11-03T00:00:00Z",
      pixelId: "1000000000000008",
      clientIp: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      eventSourceUrl: "https://upcurvv.com/w1",
    });
    const wire = toMetaWireEvent(ev);
    // Meta's CAPI requires a WEB source ("website") plus event_source_url for
    // web-attributable events; the 400 subcode 2804039 on "browser" led to "website".
    expect(wire.action_source).toBe("website");
    expect(wire.event_source_url).toBe("https://upcurvv.com/w1");
    expect(wire.event_name).toBe("PURCHASE");
    expect(wire.event_id).toBe(ev.eventId);
  });

  it("normalizes Meta EMQ to 0-10 or null (never invents a number)", async () => {
    const { normalizeMetaEmq } = await import("../src/lib/capi");
    expect(normalizeMetaEmq(9)).toBe(9);
    expect(normalizeMetaEmq("7")).toBe(7);
    expect(normalizeMetaEmq(null)).toBeNull(); // absence is not a score
    expect(normalizeMetaEmq("High")).toBeNull(); // level strings have no authoritative value
    expect(normalizeMetaEmq(11)).toBe(10); // clamped
  });

  it("postOneCapiEvent returns a structured result (never throws)", async () => {
    const calls: MetaCall[] = [];
    const res = await postOneCapiEvent({
      pixel: "1000000000000007",
      token: "tok",
      wireEvent: toMetaWireEvent(buildCapiEvent({ kind: "Lead", identity: { clientId: CLIENT, leadId: null, phone: "+911" }, eventTimeIso: "2026-11-03T00:00:00Z" })),
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_poe", event_hub_log_view: [{ event_id: "eid_poe", event_match_quality: 8 }] } })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    expect(res.fbtraceId).toBe("fbt_poe");
    expect(res.metaEventId).toBe("eid_poe");
    expect(res.emqRaw).toBe(8);
    expect(calls).toHaveLength(1);
  });
});

describe("D-11 — the literal 'pixel' placeholder can never reach Meta", () => {
  it("isValidMetaPixelId: only numeric Meta ids pass (placeholder 'pixel' / short / empty / non-string fail)", async () => {
    const { isValidMetaPixelId } = await import("../src/lib/meta/capi");
    expect(isValidMetaPixelId("4438125733120237")).toBe(true); // the .env shape
    expect(isValidMetaPixelId("  4438125733120237  ")).toBe(true); // whitespace-tolerant
    expect(isValidMetaPixelId("pixel")).toBe(false); // the G4 placeholder
    expect(isValidMetaPixelId("12345")).toBe(false); // too short (5 digits)
    expect(isValidMetaPixelId("")).toBe(false);
    expect(isValidMetaPixelId(null)).toBe(false);
    expect(isValidMetaPixelId(undefined)).toBe(false);
    expect(isValidMetaPixelId(4438125733120237)).toBe(false); // must be a string
  });

  it("placeholder pixel 'pixel' (token present) -> SIMULATE, no network, exact note; Meta is never called", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "pixel", // the exact D-11 offender
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(calls).toHaveLength(0); // NEVER a Meta POST with a placeholder
    expect(out.simulated).toBe(1);
    expect(out.live).toBe(0);
    expect(out.failed).toBe(0);
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.simulated).toBe(true);
    expect(got.sentToMeta).toBe(false); // not presented as a live send
    expect(got.pixelUsed).toBeNull(); // a placeholder is never recorded as "the pixel used"
    expect(got.error).toMatch(/not a valid numeric Meta pixel/i);
    expect(got.error).toContain("'pixel'");
    await close();
  });

  it("postOneCapiEvent rejects a placeholder pixel at the boundary (no request built, no fetch)", async () => {
    const calls: MetaCall[] = [];
    const res = await postOneCapiEvent({
      pixel: "pixel",
      token: "tok",
      wireEvent: { event_name: "PURCHASE", event_time: 1 },
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: {} })) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBeNull(); // not an HTTP error — rejected pre-network
    expect(calls).toHaveLength(0);
    expect(res.error).toMatch(/REJECTED at send boundary/);
    expect(res.error).toContain("not a valid numeric Meta pixel");
    // A valid numeric id still forms the correct Meta URL (the .env value flows through verbatim).
    const res2 = await postOneCapiEvent({
      pixel: "4438125733120237",
      token: "tok",
      wireEvent: { event_name: "PURCHASE", event_time: 1 },
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "f" } })) as unknown as typeof fetch,
    });
    expect(res2.ok).toBe(true);
    expect(String(calls[calls.length - 1].url)).toContain("/4438125733120237/events");
  });

  it("the .env value (numeric) is what reaches Meta — pixelForClient + URL, never a literal", async () => {
    const { pixelForClient } = await import("../src/lib/meta/pixel-map");
    const prev = process.env.META_PIXEL_ID_CL_UPCURVV;
    process.env.META_PIXEL_ID_CL_UPCURVV = "4438125733120237"; // the confirmed .env shape
    try {
      const pixel = pixelForClient(CLIENT);
      expect(pixel).toBe("4438125733120237"); // the .env numeric value verbatim
      expect(pixel !== "pixel").toBe(true);
      const calls: MetaCall[] = [];
      const res = await postOneCapiEvent({
        pixel: pixel as string,
        token: "tok",
        wireEvent: { event_name: "PURCHASE", event_time: 1 },
        fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "f" } })) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(true);
      expect(String(calls[0].url)).toContain("/4438125733120237/events");
      expect(String(calls[0].url)).not.toContain("/pixel/events");
    } finally {
      if (prev === undefined) delete process.env.META_PIXEL_ID_CL_UPCURVV;
      else process.env.META_PIXEL_ID_CL_UPCURVV = prev;
    }
  });

  it("D-11: valid pixel + token but NO source URL -> stays SIMULATED with a note (never POSTs a Meta-invalid 'system' web event)", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    // D-12 hermeticity: Prisma loads .env into process.env on client init, so
    // the D-12 .env URL for cl_upcurvv would otherwise satisfy the .env tier.
    // Clear it (and the pixel var, unused here) to force the no-URL path;
    // restore both afterwards.
    const savedUrl = process.env.META_EVENT_SOURCE_URL_CL_UPCURVV;
    delete process.env.META_EVENT_SOURCE_URL_CL_UPCURVV;
    let out: Awaited<ReturnType<typeof sendQueue>>;
    try {
      out = await sendQueue(prisma, CLIENT, {
        metaAccessToken: "tok",
        metaPixelId: "1000000000000009", // valid numeric pixel
        fetch: mockMeta(calls, () => ({ ok: false, status: 400, body: { error: { message: "Invalid parameter", error_subcode: 2804039 } } })) as unknown as typeof fetch,
      });
    } finally {
      if (savedUrl !== undefined) process.env.META_EVENT_SOURCE_URL_CL_UPCURVV = savedUrl;
    }
    // No source URL in ANY tier (env cleared, no Funnel row) -> no web source
    // Meta accepts on these pixels (2804039) -> the queue stays simulated,
    // no network call is made, and the note says exactly what unblocks it.
    expect(calls).toHaveLength(0);
    expect(out.simulated).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.live).toBe(0);
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.simulated).toBe(true);
    expect(got.sentToMeta).toBe(false);
    expect(got.error).toMatch(/no event source URL for this client/i);
    // D-12: the note names the two source tiers (the .env key + the Funnel)
    // so an operator knows precisely what unblocks the live send.
    expect(got.error).toMatch(/META_EVENT_SOURCE_URL/);
    expect(got.error).toMatch(/Funnel landing URL/i);
    expect(got.error).toMatch(/2804039/);
    expect(got.pixelUsed).toBeNull(); // validated pixel, not recorded as "used"
    await close();
  });

  it("D-11: valid pixel + token + a source URL -> LIVE POST with the URL (the unblocked path)", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "1000000000000010",
      eventSourceUrl: "https://upcurvv.com/w1", // injectable opt (the Funnel row is the prod source)
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_web", event_hub_log_view: [{ event_id: "eid_web", event_match_quality: 9 }] } })) as unknown as typeof fetch,
    });
    expect(out.live).toBe(1);
    expect(out.simulated).toBe(0);
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.status).toBe("sent");
    expect(got.simulated).toBe(false);
    expect(got.sentToMeta).toBe(true);
    expect(got.pixelUsed).toBe("1000000000000010");
    expect(got.metaEmq).toBe("9");
    const sentEv = JSON.parse(String(calls[0].init.body)).data[0] as Record<string, unknown>;
    expect(sentEv.action_source).toBe("website");
    expect(sentEv.event_source_url).toBe("https://upcurvv.com/w1");
    await close();
  });

  it("a settings-fallback (Client.metaPixelId) placeholder is rejected too — simulates, not a Meta 400", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "pixel", // e.g. someone typed "pixel" into the settings form
      fetch: mockMeta(calls, () => ({ ok: false, status: 400, body: { error: { message: "Unsupported post request. Object with ID 'pixel' does not exist." } } })) as unknown as typeof fetch,
    });
    expect(calls).toHaveLength(0); // the guard short-circuits BEFORE any POST
    expect(out.simulated).toBe(1);
    expect(out.failed).toBe(0); // never a 400 on 'pixel' again
    const got = await prisma.outboundEvent.findUniqueOrThrow({ where: { id: row.id } });
    expect(got.simulated).toBe(true);
    expect(got.status).toBe("sent"); // closed out as a local mark, not stuck-failed
    expect(got.sentToMeta).toBe(false);
    await close();
  });
});
