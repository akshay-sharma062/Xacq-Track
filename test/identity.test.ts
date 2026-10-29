import { describe, it, expect } from "vitest";
import {
  normalisePhone,
  normaliseEmail,
  resolveMatch,
  pickMatchingLead,
  isDuplicateCandidate,
} from "../src/lib/identity";

describe("identity — phone normalisation (spec 4)", () => {
  const cases: [string | null, string | null][] = [
    ["9812340001", "+919812340001"],
    ["919812340001", "+919812340001"], // 91 country prefix
    ["+91 98123 40001", "+919812340001"], // spaces + plus
    ["09812340001", "+919812340001"], // trunk 0
    ["+91-9812340001", "+919812340001"], // dashes
    ["(98) 1234 0001", "+919812340001"], // brackets
    ["9198 1234 0001", "+919812340001"],
    // Lenient landline fallback: any 10-digit number is accepted (spec 4).
    ["1234567890", "+911234567890"],
    ["12345", null], // too short (not 10, not 12-with-91)
    ["", null],
    [null, null],
  ];
  it.each(cases)("normalisePhone(%s) -> %s", (in0, out) => {
    expect(normalisePhone(in0)).toBe(out);
  });
});

describe("identity — email normalisation", () => {
  it("lowercases + trims", () => {
    expect(normaliseEmail("  Rohit.Iyer@Example.com ")).toBe("rohit.iyer@example.com");
  });
  it("returns null for empty", () => {
    expect(normaliseEmail("   ")).toBeNull();
    expect(normaliseEmail(null)).toBeNull();
  });
});

describe("identity — match rules", () => {
  it("phone wins over email (spec 4: phone-first)", () => {
    const r = resolveMatch({ clientId: "c", phone: "9812340001", email: "a@b.com" });
    expect(r.matchedBy).toBe("phone");
    expect(r.phoneNormalized).toBe("+919812340001");
  });
  it("falls back to email when no usable phone", () => {
    const r = resolveMatch({ clientId: "c", phone: "garbage", email: "A@B.com" });
    expect(r.matchedBy).toBe("email");
  });
  it("matchedBy null when neither usable", () => {
    const r = resolveMatch({ clientId: "c", phone: "x", email: "" });
    expect(r.matchedBy).toBeNull();
  });
});

describe("identity — never merge across clients (spec 4)", () => {
  it("same phone, different client -> no match", () => {
    const a = { clientId: "c1", phoneNormalized: "+9198", emailNormalized: null };
    const b = { clientId: "c2", phoneNormalized: "+9198", emailNormalized: null };
    expect(pickMatchingLead(a, b)).toBeNull();
  });
  it("same phone, same client -> match", () => {
    const a = { clientId: "c1", phoneNormalized: "+9198", emailNormalized: null };
    const b = { clientId: "c1", phoneNormalized: "+9198", emailNormalized: null };
    expect(pickMatchingLead(a, b)).toBe("a");
  });
});

describe("identity — duplicate candidate (spec 5.3: same email, different phone)", () => {
  it("same email + different phone = candidate", () => {
    expect(
      isDuplicateCandidate(
        { emailNormalized: "a@b.com", phoneNormalized: "+911" },
        { emailNormalized: "a@b.com", phoneNormalized: "+912" }
      )
    ).toBe(true);
  });
  it("same email + same phone = not a candidate", () => {
    expect(
      isDuplicateCandidate(
        { emailNormalized: "a@b.com", phoneNormalized: "+911" },
        { emailNormalized: "a@b.com", phoneNormalized: "+911" }
      )
    ).toBe(false);
  });
  it("different email = not a candidate", () => {
    expect(
      isDuplicateCandidate(
        { emailNormalized: "a@b.com", phoneNormalized: "+911" },
        { emailNormalized: "x@b.com", phoneNormalized: "+912" }
      )
    ).toBe(false);
  });
});
