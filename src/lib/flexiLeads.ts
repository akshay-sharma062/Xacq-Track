/**
 * "Flexi Leads" report — a receipt-level view of every FlexiFunnels webhook
 * receipt: the full raw payload (identity + every UTM value + custom form
 * answers + fbclid + page context), the ingested lead it created, and the
 * Meta ad account it resolves to. Read-only over data already on disk
 * (spec 4: `WebhookLog.rawPayload` = the exact raw body; `Event.rawPayload.meta`
 * = the record-level custom fields, D-19; `Lead`/`Touchpoint` = the ingested
 * identity + attribution). This module only reads + shapes — it writes nothing.
 *
 * Ad-account attribution (the chosen contract). FlexiFunnels payloads carry
 * UTM + fbclid, NOT Meta ad ids — but `utm_id` / `utm_term` ARE Meta ad-set /
 * ad ids (the ad-ops team puts the Meta id in the UTM params, verified against
 * the pulled ad tree). So a receipt resolves to an ad account by:
 *   1. "utm" — the receipt's `utm_term` / `utm_id` matches an AdSet / Ad /
 *      AdCampaign pulled under the client's accounts;
 *   2. "meta_touchpoint" — otherwise, the receipt's lead has a Meta ad-click
 *      touchpoint (`adRefId` → `Ad` → `AdAccount`);
 *   3. "unmatched" — neither (organic / unknown). Never guessed: an
 *      unmatched receipt is shown as organic, not attributed.
 * When an ad-account filter is set, unmatched receipts are excluded from the
 * table (they are not under that account) but counted so the KPI stays honest.
 */
import { PrismaClient } from "@prisma/client";
import { maskPhone, Session } from "./session";
import { flexiFormFieldsFromRaw } from "./adapters/payments";

export type FlexiEventKind =
  | "registered"
  | "payment_success"
  | "payment_failed"
  | "refund"
  | "other";

export type FlexiAttribution = "utm" | "meta_touchpoint" | "unmatched";

export interface FlexiLeadRow {
  /** The receipt — one row per FlexiFunnels webhook (the WebhookLog). */
  logId: string;
  receivedAt: string; // ISO
  webhookStatus: string; // "processed" | "failed" | "duplicate" | …
  eventName: string; // raw `event` / `action` value (optin, order.paid, …)
  eventKind: FlexiEventKind;
  /** Identity exactly as the payload carried it (phone masked per session). */
  identity: { name: string | null; phone: string; email: string | null; city: string | null };
  /** The ingested lead this receipt matched/created, or null (anonymous). */
  lead: {
    id: string;
    name: string | null;
    phone: string;
    email: string | null;
    stage: string;
    sourceUnknown: boolean;
  } | null;
  utm: { source?: string; medium?: string; campaign?: string; content?: string; term?: string; id?: string };
  /** `utm_flow` — a Flexi value with no Touchpoint column, carried in meta. */
  utmFlow?: string;
  fbclid?: string;
  /** Captured page context (kept out of the "form data" chips). */
  page: { path?: string; landingUrl?: string; sourceUrl?: string; redirectUrl?: string };
  /** The user-named custom form answers (the payload's unmapped fields). */
  custom: Record<string, unknown>;
  adAccount: { id: string; name: string } | null;
  attribution: FlexiAttribution;
  /** The exact raw body as received (pretty-printed by the UI; spec 4). */
  rawPayload: string;
  parsedPayload: Record<string, unknown> | null; // null = unparseable body
}

export interface FlexiLeadsReport {
  rows: FlexiLeadRow[]; // kept (post ad-account filter), newest first
  totalReceipts: number; // all flexi receipts in the client set (pre-filter)
  last24h: number; // kept receipts in the last 24 h
  uniqueLeads: number; // distinct ingested leads among the kept rows
  unmatched: number; // kept receipts with no ad-account attribution (0 when filtered)
  lastReceivedAt: string | null; // newest kept receipt (the "data as of" stamp)
}

/** Page-context / UTM-extra keys that surface as named fields, so the
 *  "form data" chips stay custom answers only (never noise). */
const FORM_EXCLUDED = new Set([
  "path", "landing_url", "source_url", "redirect_url",
  "utm_flow", "utm_id", "data",
]);

export interface FlexiLeadsOptions {
  clientIds: string[]; // the session's visible set (or the ?client= single)
  adAccountId?: string; // internal AdAccount.id (when ?adAccount= is set)
  session: Session; // for phone masking (spec 5.10)
  limit?: number; // max receipts, default 200
}

export async function flexiLeadsReport(
  prisma: PrismaClient,
  opts: FlexiLeadsOptions,
): Promise<FlexiLeadsReport> {
  const empty: FlexiLeadsReport = { rows: [], totalReceipts: 0, last24h: 0, uniqueLeads: 0, unmatched: 0, lastReceivedAt: null };
  if (opts.clientIds.length === 0) return empty;
  const limit = opts.limit ?? 200;
  const { clientIds, session } = opts;

  // --- Meta id → ad account (the UTM match key): ad-set / ad / campaign ids
  //     pulled under the client set, scoped to the selected account when set.
  const idWhere = {
    clientId: { in: clientIds },
    ...(opts.adAccountId ? { adAccountId: opts.adAccountId } : {}),
  };
  const [sets, ads, cames, accts] = await Promise.all([
    prisma.adSet.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.ad.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.adCampaign.findMany({ where: idWhere, select: { metaId: true, adAccountId: true } }),
    prisma.adAccount.findMany({
      where: { clientId: { in: clientIds }, ...(opts.adAccountId ? { id: opts.adAccountId } : {}) },
      select: { id: true, name: true },
    }),
  ]);
  const idToAcct = new Map<string, string>();
  for (const r of [...sets, ...ads, ...cames]) idToAcct.set(r.metaId, r.adAccountId);
  const acctName = new Map(accts.map((a) => [a.id, a.name]));

  // --- The receipts, newest first.
  const where = { platform: "flexifunnels", clientId: { in: clientIds } };
  const [logs, totalReceipts] = await Promise.all([
    prisma.webhookLog.findMany({
      where, orderBy: { receivedAt: "desc" }, take: limit,
      include: { events: { select: { leadId: true, type: true } } },
    }),
    prisma.webhookLog.count({ where }),
  ]);

  // The ingested leads these receipts created/matched (one batch).
  const leadIds = [...new Set(
    logs.flatMap((l) => l.events.map((e) => e.leadId).filter((v): v is string => Boolean(v))),
  )];
  const leadRows = leadIds.length ? await prisma.lead.findMany({ where: { id: { in: leadIds } } }) : [];
  const leadById = new Map(leadRows.map((l) => [l.id, l]));

  const str = (...vals: unknown[]): string | undefined => {
    for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
    return undefined;
  };

  // --- Pass 1: shape every receipt.
  const rows: FlexiLeadRow[] = [];
  const rowLeadIds = new Map<number, string | null>();
  for (const log of logs) {
    let parsed: Record<string, unknown> | null = null;
    try {
      const body: unknown = JSON.parse(log.rawPayload || "null");
      parsed = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
      parsed = null; // unparseable — the row is still shown, honestly
    }
    const f = parsed ? flexiFormFieldsFromRaw(parsed) : null;
    const custom = (f?.custom ?? {}) as Record<string, unknown>;
    const nested = (custom.data ?? {}) as Record<string, unknown>;

    const formFields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(custom)) if (!FORM_EXCLUDED.has(k)) formFields[k] = v;

    const evType = log.events[0]?.type;
    const eventKind: FlexiEventKind =
      evType === "registered" ? "registered"
      : evType === "payment_success" ? "payment_success"
      : evType === "payment_failed" ? "payment_failed"
      : evType === "refund" ? "refund"
      : "other";

    const leadId = log.events.map((e) => e.leadId).find(Boolean) ?? null;
    const leadRow = leadId ? leadById.get(leadId) : undefined;

    // 1) UTM attribution: the Meta id lives in `utm_term` (ad level) or
    //    `utm_id` (ad-set level) — try the term first (it is the ad id).
    let adAccountId: string | null = null;
    let attribution: FlexiAttribution = "unmatched";
    for (const cand of [f?.utm.term, f?.utm.id].filter((v): v is string => Boolean(v))) {
      const hit = idToAcct.get(cand);
      if (hit) { adAccountId = hit; attribution = "utm"; break; }
    }

    const row: FlexiLeadRow = {
      logId: log.id,
      receivedAt: log.receivedAt.toISOString(),
      webhookStatus: log.status,
      eventName: str(parsed?.event, parsed?.action) ?? "",
      eventKind,
      identity: {
        name: f?.name ?? null,
        phone: f?.phone ? maskPhone(f.phone, session) : "",
        email: f?.email ?? null,
        city: f?.city ?? null,
      },
      lead: leadRow
        ? {
            id: leadRow.id,
            name: leadRow.name,
            phone: maskPhone(leadRow.phone, session),
            email: leadRow.email,
            stage: leadRow.stage,
            sourceUnknown: leadRow.sourceUnknown,
          }
        : null,
      utm: f?.utm ?? {},
      utmFlow: str(custom.utm_flow, nested.utm_flow),
      fbclid: f?.fbclid,
      page: {
        path: str(custom.path, nested.path),
        landingUrl: str(custom.landing_url, nested.landing_url),
        sourceUrl: str(custom.source_url, nested.source_url),
        redirectUrl: str(custom.redirect_url, nested.redirect_url),
      },
      custom: formFields,
      adAccount: adAccountId ? { id: adAccountId, name: acctName.get(adAccountId) ?? adAccountId } : null,
      attribution,
      rawPayload: log.rawPayload,
      parsedPayload: parsed,
    };
    rows.push(row);
    rowLeadIds.set(rows.length - 1, leadId); // parallel map — the lead a receipt ingested
  }

  // --- Pass 2: the Meta-touchpoint fallback, batched for the still-unmatched.
  //     The lead's own ad-click touchpoint (adRefId → Ad → AdAccount) carries
  //     the account when the UTM values did not resolve to a pulled ad.
  const unmatchedLeadIds = [...new Set(
    rows.map((r, i) => r.attribution === "unmatched" ? rowLeadIds.get(i) : null)
      .filter((v): v is string => Boolean(v)),
  )];
  if (unmatchedLeadIds.length) {
    const tps = await prisma.touchpoint.findMany({
      where: { leadId: { in: unmatchedLeadIds }, adRefId: { not: null } },
      select: { leadId: true, adRefId: true },
    });
    // Any ad-carrying touchpoint on the lead resolves the account (we only
    // need the account, not which specific ad).
    const adRefByLead = new Map<string, string>();
    for (const t of tps) if (t.leadId && t.adRefId && !adRefByLead.has(t.leadId)) adRefByLead.set(t.leadId, t.adRefId);
    const adRefIds = [...new Set(adRefByLead.values())];
    const adRows = adRefIds.length
      ? await prisma.ad.findMany({ where: { metaId: { in: adRefIds } }, select: { metaId: true, adAccountId: true } })
      : [];
    const adAcctByRef = new Map(adRows.map((a) => [a.metaId, a.adAccountId]));
    rows.forEach((r, i) => {
      if (r.attribution !== "unmatched") return;
      const lid = rowLeadIds.get(i);
      const ref = lid ? adRefByLead.get(lid) : undefined;
      const acc = ref ? adAcctByRef.get(ref) : undefined;
      if (acc) {
        r.adAccount = { id: acc, name: acctName.get(acc) ?? acc };
        r.attribution = "meta_touchpoint";
      }
    });
  }

  // --- Filter + KPIs.
  const kept = opts.adAccountId
    ? rows.filter((r) => r.adAccount?.id === opts.adAccountId) // unmatched drops
    : rows;
  const dayAgo = Date.now() - 86_400_000;
  return {
    rows: kept,
    totalReceipts,
    last24h: kept.filter((r) => new Date(r.receivedAt).getTime() >= dayAgo).length,
    uniqueLeads: new Set(kept.map((r) => r.lead?.id).filter(Boolean)).size,
    unmatched: opts.adAccountId ? 0 : kept.filter((r) => r.attribution === "unmatched").length,
    lastReceivedAt: kept[0]?.receivedAt ?? null,
  };
}
