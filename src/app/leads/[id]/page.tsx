import { notFound } from "next/navigation";
import { Topbar } from "../../components/Topbar";
import { inr, ist, Thumbnail } from "../../components/ui";
import { getSession } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";
import { maskPhone } from "@/lib/session";
import { maskEmail, resolveLeadFormFields } from "@/lib/leadFormFields";
import { LeadActions } from "./LeadActions";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * Screen 3 — Lead timeline (the main screen, spec 5.4).
 * Header (name/phone/email/client/stage/owner/total paid) + source card
 * (first/last ad clicked, count of ad clicks, thumbnail + name) + the full
 * event timeline, newest first, with platform icons and IST times.
 */
export default async function LeadTimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const s = await getSession();
  if (!s) notFound();
  const { id } = await params;

  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      client: true,
      funnel: true,
      owner: true,
      payments: true,
      events: { orderBy: { timestamp: "desc" } },
      touchpoints: { orderBy: { timestamp: "asc" } },
    },
  });
  if (!lead) notFound();

  const totalPaid = lead.payments.reduce(
    (sum, p) => sum + (p.status === "paid" ? p.amount : p.status === "refunded" ? -p.amount : 0),
    0
  );

  // Source card: ad clicks from touchpoints that carry an ad (spec 3).
  const adClicks = lead.touchpoints.filter((t) => t.adId);
  const firstAd = adClicks[0];
  const lastAd = adClicks[adClicks.length - 1];
  const adNames = new Set<string>();
  if (firstAd?.adRefId) adNames.add(firstAd.adRefId);
  if (lastAd?.adRefId) adNames.add(lastAd.adRefId);
  const ads = adNames.size
    ? await prisma.ad.findMany({
        where: { metaId: { in: [...adNames] } },
        include: { creatives: { take: 1 } },
      })
    : [];
  const adByMeta = new Map(ads.map((a) => [a.metaId, a]));

  const phone = maskPhone(lead.phone, s);
  const email = maskEmail(lead.email, s);

  // D-19b: the "Form data" card. Resolve the FlexiFunnels form fields from the
  // lead's flexi events — record-level `meta` first (D-19), falling back to the
  // linked WebhookLog raw body (pre-D-19). Nothing is invented: when neither
  // source carries usable fields, `formFields` is null and the card hides.
  const flexiEvents = lead.events.filter((e) => e.sourcePlatform === "flexifunnels");
  const logIds = [...new Set(flexiEvents.map((e) => e.webhookLogId).filter((id): id is string => Boolean(id)))];
  const linkedLogs = logIds.length
    ? await prisma.webhookLog.findMany({
        where: { id: { in: logIds }, clientId: lead.clientId },
        select: { id: true, rawPayload: true },
      })
    : [];
  const formFields = resolveLeadFormFields(
    flexiEvents.map((e) => ({ rawPayload: e.rawPayload, webhookLogId: e.webhookLogId })),
    linkedLogs[0]?.rawPayload ?? null
  );

  // Platform icon + tone for each event type (spec 5.4 timeline).
  const toneOf = (type: string, platform: string) => {
    if (["payment_success", "refund"].includes(type)) return "money";
    if (type === "refund") return "alert";
    if (platform === "meta") return "meta";
    return "";
  };
  const ICON: Record<string, string> = {
    meta: "◉", aevent: "▶", zoom: "▶", calendly: "☎", razorpay: "₹", cashfree: "₹",
    tagmango: "₹", cosmofeed: "₹", flexifunnels: "₹", pabbly: "⚡", whatsapp: "✉",
    xt: "↗", sheets: "▦", manual: "✎",
  };

  return (
    <>
      <Topbar title="Lead timeline" crumb={`Leads / ${lead.name ?? phone}`} />

      <div className="card mb">
        <div className="row spread">
          <div>
            <div className="row">
              <h1 style={{ margin: 0, fontSize: 18 }}>{lead.name ?? "Unknown"}</h1>
              <span className={`stage ${lead.stage}`}>{lead.stage}</span>
              {lead.isDuplicateCandidate ? <span className="badge bad">duplicate candidate</span> : null}
              {lead.sourceUnknown ? <span className="badge warn">source unknown</span> : null}
            </div>
            <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
              {phone} · {email || "no email"} · {lead.city ?? "—"}
            </div>
            <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>
              {lead.client.name} · {lead.funnel?.name ?? "no funnel"} · owner {lead.owner?.name ?? "—"}
            </div>
          </div>
          <div className="stat" style={{ minWidth: 140 }}>
            <span className="k">Total paid (net)</span>
            <span className="v" style={{ color: totalPaid >= 0 ? "var(--good)" : "var(--bad)" }}>
              {inr(totalPaid)}
            </span>
          </div>
        </div>
      </div>

      <div className="grid cols-3 mb">
        <SourceAd ad={firstAd ? adByMeta.get(firstAd.adRefId ?? "") : undefined} label="First ad clicked" ts={firstAd?.timestamp} />
        <SourceAd ad={lastAd ? adByMeta.get(lastAd.adRefId ?? "") : undefined} label="Last ad clicked" ts={lastAd?.timestamp} />
        <div className="card">
          <div className="stat">
            <span className="k">Ad clicks</span>
            <span className="v">{adClicks.length}</span>
            <span className="d muted">distinct touchpoints w/ an ad</span>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Timeline</h3>
          <div className="tl">
            {lead.events.map((e) => (
              <div key={e.id} className={`item ${toneOf(e.type, e.sourcePlatform)}`}>
                <div className="t">
                  <div>
                    <strong>{humanType(e.type)}</strong>{" "}
                    <span className="faint">via {e.sourcePlatform}</span>{" "}
                    {ICON[e.sourcePlatform] ? <span className="faint">{ICON[e.sourcePlatform]}</span> : null}
                    {e.minutesWatched ? <span className="faint"> · {e.minutesWatched} min</span> : null}
                  </div>
                  <span className="when">{ist(e.timestamp.toISOString())}</span>
                </div>
                {e.value ? (
                  <div className="mono" style={{ color: "var(--good)", fontSize: 12 }}>
                    {inr(e.value)} {e.currency}
                    {e.type === "refund" ? " refund" : ""}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div className="stack">
          {formFields ? <FormDataCard fields={formFields} lead={lead} session={s} /> : null}
          <div className="card">
            <h3>Payments</h3>
            {lead.payments.length === 0 ? (
              <div className="empty">No payments yet</div>
            ) : (
              lead.payments.map((p) => (
                <div key={p.id} className="row spread" style={{ padding: "6px 0" }}>
                  <span>
                    {p.product ?? p.gateway} <span className="faint">({p.gateway})</span>
                  </span>
                  <span className={`mono ${p.status === "refunded" ? "bad" : p.status === "paid" ? "good" : "muted"}`}>
                    {inr(p.amount)} · {p.status}
                  </span>
                </div>
              ))
            )}
          </div>
          <LeadActions leadId={lead.id} stage={lead.stage} canStage={true} canNote={true} />
        </div>
      </div>
      <div className="row mt">
        <Link className="btn" href="/leads">← All leads</Link>
      </div>
    </>
  );
}

function SourceAd({
  ad,
  label,
  ts,
}: {
  ad?: { name: string; metaId: string; creatives: { thumbnailUrl: string | null }[] };
  label: string;
  ts?: Date;
}) {
  return (
    <div className="card">
      <div className="row spread mb">
        <span className="k muted" style={{ fontSize: 12 }}>
          {label}
        </span>
        {ts ? <span className="faint" style={{ fontSize: 11 }}>{ist(ts.toISOString())}</span> : null}
      </div>
      {ad ? (
        <div className="row">
          <Thumbnail url={ad.creatives[0]?.thumbnailUrl} name={ad.name} />
          <div>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{ad.name}</div>
            <div className="faint mono" style={{ fontSize: 11 }}>
              {ad.metaId}
            </div>
          </div>
        </div>
      ) : (
        <div className="empty" style={{ padding: 8 }}>no ad click</div>
      )}
    </div>
  );
}

/** D-19b: the "Form data" card. Shows what the FlexiFunnels form actually
 *  captured — identity (masked per the session, the existing maskPhone/maskEmail
 *  rule) + the user-named custom answers + the UTM extras (utm_id / utm_flow)
 *  + fbclid. The five standard UTM fields live on the lead's touchpoints and
 *  are already shown in the ad-context cards above, so this card adds only the
 *  form-specific data the lead view otherwise never surfaces. A human label
 *  uses a D-16 mapping where one exists; otherwise the raw key is prettified. */
function FormDataCard({
  fields,
  lead,
  session,
}: {
  fields: {
    from: "event-meta" | "webhook-log";
    custom: Record<string, unknown>;
    utmExtras: { utm_id?: string; utm_flow?: string };
    fbclid?: string;
  };
  lead: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    city?: string | null;
    touchpoints: { utmSource?: string | null; utmCampaign?: string | null; adId?: string | null; fbclid?: string | null }[];
  };
  session: Parameters<typeof maskPhone>[1];
}) {
  const phone = maskPhone(lead.phone, session);
  const email = maskEmail(lead.email, session);
  // Flat custom fields. The adapter namespaces the nested `data` envelope
  // (envelope-shaped payloads) under a `data` key, so we flatten it out.
  const customEntries: [string, unknown][] = [];
  for (const [k, v] of Object.entries(fields.custom)) {
    if (k === "data" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [nk, nv] of Object.entries(v as Record<string, unknown>)) {
        customEntries.push([`data.${nk}`, nv]);
      }
    } else if (v != null && v !== "") {
      customEntries.push([k, v]);
    }
  }
  // the most recent touchpoint that carries a UTM source (the form's ad context)
  const utmTouch = [...lead.touchpoints].reverse().find((t) => t.utmSource || t.utmCampaign);

  return (
    <div className="card">
      <div className="row spread mb">
        <h3 style={{ margin: 0 }}>Form data</h3>
        <span className="faint" style={{ fontSize: 11 }}>
          {fields.from === "event-meta" ? "from the form event" : "from the stored webhook body"}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 12, marginBottom: 8 }}>
        <div>{lead.name ?? "—"} · {phone || "—"} · {email || "—"}</div>
        <div className="faint">{lead.city ?? "no city"}</div>
      </div>
      {customEntries.length ? (
        <div style={{ marginBottom: 8 }}>
          {customEntries.map(([k, v]) => (
            <div key={k} className="row spread" style={{ padding: "3px 0", fontSize: 13 }}>
              <span className="k muted" style={{ fontSize: 12 }}>{prettyKey(k)}</span>
              <span className="mono" style={{ fontSize: 12, wordBreak: "break-word", textAlign: "right" }}>
                {v == null ? "—" : String(v)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {(fields.utmExtras.utm_id || fields.utmExtras.utm_flow) ? (
        <div className="mono muted" style={{ fontSize: 12, marginBottom: 4 }}>
          {fields.utmExtras.utm_id ? <div>utm_id: {fields.utmExtras.utm_id}</div> : null}
          {fields.utmExtras.utm_flow ? <div>utm_flow: {fields.utmExtras.utm_flow}</div> : null}
        </div>
      ) : null}
      {utmTouch ? (
        <div className="faint" style={{ fontSize: 11 }}>
          Ad context{utmTouch.utmSource ? ` · ${utmTouch.utmSource}` : ""}
          {utmTouch.utmCampaign ? ` · ${utmTouch.utmCampaign}` : ""}
        </div>
      ) : null}
    </div>
  );
}

/** A raw form key → a human label. FlexiFunnels keys are user-named
 *  ("what's_your_current_it"); no D-16 mapping stores a label for them, so we
 *  prettify: underscores → spaces, title case. No invented mapping. */
function prettyKey(k: string): string {
  return k
    .replace(/[_.]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function humanType(t: string) {
  const map: Record<string, string> = {
    ad_click: "Ad click",
    page_view: "Page view",
    form_submit: "Form submitted",
    meta_form_lead: "Meta Instant Form lead",
    registered: "Registered",
    webinar_joined: "Webinar joined",
    webinar_left: "Webinar left",
    replay_watched: "Replay watched",
    whatsapp_sent: "WhatsApp sent",
    whatsapp_replied: "WhatsApp reply",
    call_booked: "Call booked",
    call_cancelled: "Call cancelled",
    call_done: "Call done",
    checkout_started: "Checkout started",
    payment_success: "Payment",
    payment_failed: "Payment failed",
    refund: "Refund",
    stage_changed: "Stage changed",
    note_added: "Note added",
  };
  return map[t] ?? t;
}
