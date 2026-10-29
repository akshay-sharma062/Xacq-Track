/**
 * Meta Lead Form (Instant Form) adapter (spec 5.2 / 6).
 *
 * Meta's leadgen webhook posts a notification; we then fetch the full lead via
 * the Marketing/Leadgen API. The lead object carries ad_id, adset_id,
 * campaign_id, form_id + a field array (question -> value). A per-form field
 * mapping (see MetaLeadForm.fieldsMapping) tells us which question is phone,
 * email, name, city, or a custom answer.
 *
 * The sample below is a realistic (fake) lead payload + a `__mapping` hint the
 * ingest layer will merge with the stored FormFieldMapping in prod.
 */
import { Adapter, NormalizedInbound } from "./types";

// A saved sample payload (spec 8). Replayed by test/adapters.test.ts.
const SAMPLE = {
  id: "lead_2024_0001",
  ad_id: "ad_103",
  adset_id: "aset_1",
  campaign_id: "cam_launch",
  form_id: "form_iit_001",
  created_time: "2024-05-01T09:12:00+05:30",
  fields: [
    { name: "What is your name?", value: "Rohit Iyer" },
    { name: "Phone number", value: "98 1234 0008" },
    { name: "Email", value: "Rohit.Iyer@Example.com" },
    { name: "City", value: "Delhi" },
    { name: "What are you preparing for?", value: "IIT 2025" },
  ],
  // Hint the ingest will normally resolve from the stored mapping.
  __mapping: { name: "name", phone: "phone", email: "email", city: "city" },
};

function findField(fields: { name: string; value: string }[], label: string | undefined): string | undefined {
  if (!label) return undefined;
  return fields.find((f) => f.name === label)?.value;
}

export const metaLeadFormAdapter: Adapter = {
  platform: "meta",
  label: "Meta Instant Form (Lead Form)",
  sample: SAMPLE,
  parse(payload: unknown): NormalizedInbound[] {
    const p = payload as any;
    if (!p || Array.isArray(p)) return [];
    const fields = Array.isArray(p.fields) ? p.fields : [];
    const map: Record<string, string> = p.__mapping ?? {};
    // Without an explicit mapping, fall back to common question labels.
    const name = findField(fields, map.name) ?? findField(fields, "What is your name?") ?? findField(fields, "Full Name");
    const phone = findField(fields, map.phone) ?? findField(fields, "Phone number") ?? findField(fields, "Phone");
    const email = findField(fields, map.email) ?? findField(fields, "Email") ?? findField(fields, "Email address");
    const city = findField(fields, map.city) ?? findField(fields, "City");
    return [
      {
        platform: "meta",
        type: "meta_form_lead",
        name, phone, email, city,
        adId: p.ad_id, adsetId: p.adset_id, campaignId: p.campaign_id,
        fbc: p.fbclid ? `fb.${p.fbclid}` : undefined,
        fbclid: p.fbclid,
        upstreamId: p.id ?? p.leadgen_id,
        occurredAt: p.created_time,
        raw: p,
      },
    ];
  },
};

// Marketing API pull is not a webhook — it is in meta/pull.ts.
