import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  buildCapiEvent,
  capiDedupKey,
  shouldSendPurchase,
  estimateMatchQuality,
  CAPI_EVENT_NAME,
} from "../src/lib/capi";
import { hashPhoneForCapi, hashEmailForCapi, hashCapiEventId } from "../src/lib/hash";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("CAPI — hashing (spec 5.8 / 10: hash before it leaves the server)", () => {
  it("phone hash = SHA-256 of E.164 WITHOUT the leading +", () => {
    expect(hashPhoneForCapi("+919812340001")).toBe(sha("919812340001"));
    // Defensive: a stray + or spaces never poison the hash.
    expect(hashPhoneForCapi("+91 98123 40001")).toBe(sha("919812340001"));
  });

  it("email hash = SHA-256 of trimmed lowercased email", () => {
    expect(hashEmailForCapi("  Rohit.Iyer@Example.com ")).toBe(sha("rohit.iyer@example.com"));
  });

  it("event_id hash is stable across replays", () => {
    expect(hashCapiEventId("abc")).toBe(hashCapiEventId("ABC "));
  });
});

describe("CAPI — dedup key (spec 5.8: never send twice)", () => {
  const id = { clientId: "c1", leadId: "l1", phone: "+9198", email: "a@b.com" };
  it("folds client + identity in", () => {
    expect(capiDedupKey("Purchase", id, "rzp_txn_001")).toBe("Purchase:c1:+9198:rzp_txn_001");
  });
  it("two gateways reporting the same sale share the txn discriminator -> same key", () => {
    expect(capiDedupKey("Purchase", id, "txn_1")).toBe(capiDedupKey("Purchase", id, "txn_1"));
    expect(capiDedupKey("Purchase", id, "txn_1")).not.toBe(capiDedupKey("Purchase", id, "txn_2"));
  });
});

describe("CAPI — payload builder", () => {
  it("builds a hashed Purchase with value + currency", () => {
    const ev = buildCapiEvent({
      kind: "Purchase",
      identity: { clientId: "c", leadId: "l", phone: "+919812340001", email: "a@b.com", fbc: "fb.x", fbp: "123" },
      value: 24999,
      currency: "INR",
      eventTimeIso: "2024-05-01T09:00:00+05:30",
      discriminator: "txn_9",
      pixelId: "px_1",
    });
    expect(ev.actionType).toBe("Purchase");
    expect(ev.eventSource).toBe("server");
    expect(ev.eventTime).toBe(Math.floor(new Date("2024-05-01T09:00:00+05:30").getTime() / 1000));
    expect(ev.customData).toEqual({ value: 24999, currency: "INR" });
    expect(ev.userData.ph).toBe(sha("919812340001"));
    expect(ev.userData.em).toBe(sha("a@b.com"));
    expect(ev.userData.fbc).toBe("fb.x");
    expect(ev.userData.fbp).toBe("123");
    expect(ev.pixelId).toBe("px_1");
    // event_id is a stable slice of the dedup-key hash (dedup with the pixel).
    expect(ev.eventId.length).toBe(40);
  });

  it("omits value on non-purchase events", () => {
    const ev = buildCapiEvent({
      kind: "Lead",
      identity: { clientId: "c", leadId: "l", phone: "+9198" },
      eventTimeIso: "2024-05-01T09:00:00Z",
    });
    expect(ev.customData).toEqual({});
    expect(ev.userData.ph).toBe(sha("9198"));
  });

  it("maps event kinds to Meta names (spec 3)", () => {
    expect(CAPI_EVENT_NAME.CompleteRegistration).toBe("CompleteRegistration");
    expect(CAPI_EVENT_NAME.Attended).toBe("Attended");
  });
});

describe("CAPI — send guard (spec 5.8: never Purchase for a refund)", () => {
  const withId = { clientId: "c", leadId: "l", phone: "+9198", email: "a@b.com" };
  it("refunded payment -> do not send Purchase", () => {
    const g = shouldSendPurchase({ refunded: true, identity: withId });
    expect(g.send).toBe(false);
  });
  it("no phone/email -> cannot match, skip", () => {
    const g = shouldSendPurchase({
      refunded: false,
      identity: { clientId: "c", leadId: "l" },
    });
    expect(g.send).toBe(false);
  });
  it("paid + identity -> send", () => {
    expect(shouldSendPurchase({ refunded: false, identity: withId }).send).toBe(true);
  });
});

describe("CAPI — match quality heuristic", () => {
  it("scores phone > email > fbc > fbp (capped at 10)", () => {
    expect(estimateMatchQuality({ clientId: "c", leadId: "l", phone: "+91", email: "a@b.com", fbc: "fb.x", fbp: "1" })).toBe(10);
    expect(estimateMatchQuality({ clientId: "c", leadId: "l", phone: "+91" })).toBe(4);
    expect(estimateMatchQuality({ clientId: "c", leadId: "l" })).toBe(0);
  });
});
