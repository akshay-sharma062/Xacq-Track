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
      metaPixelId: "px_live",
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
    expect(got.pixelUsed).toBe("px_live");
    await close();
  });

  it("live wire format: Meta's real user_data keys + frozen event_id + value/currency", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const calls: MetaCall[] = [];
    await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "px_wire",
      fetch: mockMeta(calls, () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_w" } })) as unknown as typeof fetch,
    });
    const req = JSON.parse(String(calls[0].init.body)) as { data: Record<string, unknown>[] };
    const ev = req.data[0];
    expect(ev.action_type).toBe("Purchase");
    expect(ev.event_name).toBe("PURCHASE"); // Meta's required event_name (standard name)
    expect(ev.event_id).toBe(capiWireEventId(row.dedupKey)); // frozen from the stored dedupKey
    // Meta's REAL user_data keys — unknown keys (client_ip / user_agent) are
    // silently dropped by Meta, so the exact names are what raise EMQ.
    expect(ev.user_data).toMatchObject({ client_ip_address: "10.0.0.9", client_user_agent: "g8-live-test/1.0", fbc: "fb.g8", fbp: "g8-fbp" });
    expect((ev.user_data as Record<string, unknown>).ph).toBe(hashPhoneForCapi("+919812340099"));
    expect((ev.user_data as Record<string, unknown>).em).toBe(hashEmailForCapi("g8lead@x.com"));
    expect(ev.custom_data).toEqual({ value: 4999, currency_code: "INR" }); // Meta's custom_data field name
    expect(String(calls[0].url)).toContain("/px_wire/events");
    await close();
  });

  it("4xx BLOCKED: records the EXACT Meta error string, never a canned success", async () => {
    const { prisma, row, close } = await seedPurchaseRow();
    const out = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "px_403",
      fetch: mockMeta([], () => ({ ok: false, status: 403, body: { error: { message: "Unsupported post request. Object with ID 'px_403' does not exist." } } })) as unknown as typeof fetch,
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
      metaPixelId: "px_dedup",
      fetch: mockMeta([], () => ({ ok: true, status: 200, body: { fbtrace_id: "fbt_d" } })) as unknown as typeof fetch,
    });
    // Second run with a fresh counting spy: zero fetch calls, row unchanged.
    const calls: MetaCall[] = [];
    const out2 = await sendQueue(prisma, CLIENT, {
      metaAccessToken: "tok",
      metaPixelId: "px_dedup",
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
      metaPixelId: "px_ref",
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
      metaPixelId: "px_no_tok",
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
      pixelId: "px_1",
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
    expect((wire.user_data as Record<string, unknown>).client_ip_address).toBe("1.2.3.4");
    expect((wire.user_data as Record<string, unknown>).client_user_agent).toBe("ua");
    expect(wire.event_id).toBe(capiWireEventId("Purchase:" + CLIENT)); // frozen
  });

  it("web-source wire: a source URL flips action_source to 'website' and adds event_source_url", () => {
    const ev = buildCapiEvent({
      kind: "Purchase",
      identity: { clientId: CLIENT, leadId: "l", phone: "+919812340001", email: "a@b.com" },
      value: 100,
      currency: "INR",
      eventTimeIso: "2026-11-03T00:00:00Z",
      pixelId: "px_1",
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
      pixel: "px_poe",
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
