import { Topbar } from "../components/Topbar";
import { AutoRefresh } from "../components/AutoRefresh";
import { ist, Stat } from "../components/ui";
import { getSession, resolveClientSet, qs } from "@/lib/api-utils";
import { flexiLeadsReport, FlexiLeadRow } from "@/lib/flexiLeads";
import { resolveAdAccountId, resolveAdAccountIdInSet } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

/**
 * Screen — "Flexi Leads": a receipt-level report of every FlexiFunnels webhook.
 * Each row = one `WebhookLog` receipt: the full raw payload (identity + every
 * UTM value + custom form answers + fbclid + page context), the ingested lead
 * it created, and the Meta ad account it resolves to (UTM ad-set/ad id, else
 * the lead's Meta ad-click touchpoint, else "unmatched/organic").
 *
 * Ad-account filter: the Topbar's existing dropdown writes `?adAccount=` (its
 * options come from the AdAccount rows); this page resolves it with the same
 * D-01 helpers the Reports screen uses. Live updates: the 60 s `AutoRefresh`
 * re-renders the server page, so a freshly received webhook appears on the
 * next tick without a manual reload.
 */
export const dynamic = "force-dynamic";

export default async function FlexiLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Flexi Leads" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientSet = await resolveClientSet(s, sp.client ?? "all");
  if (clientSet.length === 0) {
    return (
      <>
        <Topbar title="Flexi Leads" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }
  const isAll = clientSet.length > 1 && (sp.client === undefined || sp.client === "all");
  const adAccountId = isAll
    ? await resolveAdAccountIdInSet(prisma, clientSet, sp.adAccount)
    : await resolveAdAccountId(prisma, clientSet[0], sp.adAccount);

  const rep = await flexiLeadsReport(prisma, {
    clientIds: clientSet,
    adAccountId,
    session: s,
  });

  // Any flexi receipts at all in the client set (to split the empty state):
  const anyReceipts = rep.totalReceipts > 0 || rep.rows.length > 0;
  const adAccountName = adAccountId
    ? (await prisma.adAccount.findUnique({ where: { id: adAccountId } }))?.name ?? null
    : null;

  return (
    <>
      <Topbar
        title="Flexi Leads"
        crumb={
          `${rep.rows.length} FlexiFunnels receipts · ${rep.uniqueLeads} leads` +
          (adAccountName ? ` · ${adAccountName}` : "")
        }
      />

      <AutoRefresh dataAsOf={rep.lastReceivedAt} />

      <div className="grid cols-4 mb">
        <Stat
          label="Flexi receipts (24 h)"
          value={rep.last24h}
          sub={`${rep.totalReceipts} total`}
          tone="accent"
        />
        <Stat label="Unique Flexi leads" value={rep.uniqueLeads} />
        <Stat
          label="Unmatched / organic"
          value={rep.unmatched}
          sub="no ad account resolved"
          tone={rep.unmatched > 0 ? "warn" : "good"}
        />
        <Stat label="Last receipt" value={rep.lastReceivedAt ? ist(rep.lastReceivedAt) : "—"} sub="IST" />
      </div>

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Receipt (IST)</th>
              <th>Lead</th>
              <th>Event</th>
              <th>Ad account</th>
              <th>UTM</th>
              <th>Form data (custom answers)</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rep.rows.length === 0 && !anyReceipts && (
              <tr>
                <td colSpan={7} className="empty">
                  No FlexiFunnels webhooks received yet — receipts land here
                  automatically the moment a FlexiFunnels form/purchase webhook
                  hits the connection (auto-refresh every 60 s).
                </td>
              </tr>
            )}
            {rep.rows.length === 0 && anyReceipts && (
              <tr>
                <td colSpan={7} className="empty">
                  No receipts match this ad-account filter — some may be
                  unmatched/organic ({rep.unmatched} total, not shown while
                  filtered).
                </td>
              </tr>
            )}
            {rep.rows.map((r) => (
              <FlexiRow key={r.logId} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function FlexiRow({ row: r }: { row: FlexiLeadRow }) {
  const utmLine = [r.utm.source, r.utm.medium, r.utm.campaign].filter(Boolean).join(" › ");
  const chips = Object.entries(r.custom);
  return (
    <>
      <tr>
        <td style={{ whiteSpace: "nowrap" }}>
          <div className="mono" style={{ fontSize: 11 }}>{ist(r.receivedAt)}</div>
          <div>
            <span className={`badge ${r.webhookStatus === "processed" ? "good" : r.webhookStatus === "duplicate" ? "warn" : "bad"}`}>
              {r.webhookStatus}
            </span>
          </div>
        </td>
        <td>
          {r.lead ? (
            <>
              <Link href={`/leads/${r.lead.id}`} style={{ color: "inherit" }}>
                <strong>{r.lead.name ?? r.identity.name ?? "—"}</strong>
              </Link>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {r.lead.phone || "no phone"}
              </div>
              {r.lead.sourceUnknown ? (
                <span className="badge warn" style={{ fontSize: 10 }}>source unknown</span>
              ) : null}
            </>
          ) : (
            <>
              <strong>{r.identity.name ?? "anonymous receipt"}</strong>
              <div className="mono muted" style={{ fontSize: 11 }}>
                {[r.identity.phone, r.identity.email].filter(Boolean).join(" · ") || "no identity in payload"}
              </div>
            </>
          )}
        </td>
        <td>
          <span className={`badge ${kindTone(r.eventKind)}`}>{kindLabel(r.eventKind)}</span>
          {r.eventName ? (
            <div className="faint mono" style={{ fontSize: 10, wordBreak: "break-word" }}>{r.eventName}</div>
          ) : null}
        </td>
        <td>
          {r.adAccount ? (
            <>
              <strong>{r.adAccount.name}</strong>
              <div>
                <span className={`badge ${r.attribution === "utm" ? "accent" : "good"}`} style={{ fontSize: 10 }}>
                  {r.attribution === "utm" ? "UTM" : "Meta click"}
                </span>
              </div>
            </>
          ) : (
            <span className="badge" style={{ fontSize: 10 }}>
              <span className="faint">organic / unmatched</span>
            </span>
          )}
        </td>
        <td style={{ minWidth: 220 }}>
          {utmLine ? (
            <div title={utmLine} style={{ fontSize: 12 }}>
              {utmLine}
            </div>
          ) : (
            <span className="faint">no UTM</span>
          )}
          <div className="mono faint" style={{ fontSize: 10 }}>
            {[`term ${r.utm.term}`.trim(), `id ${r.utm.id}`.trim()].filter((v) => v !== "term" && v !== "id").join(" · ")}
          </div>
          {r.fbclid ? (
            <div className="mono faint" style={{ fontSize: 10, wordBreak: "break-all" }} title="fbclid">
              fbclid {r.fbclid}
            </div>
          ) : null}
        </td>
        <td style={{ minWidth: 220 }}>
          {chips.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 380 }}>
              {chips.map(([k, v]) => (
                <span key={k} className="badge" title={`${k}: ${String(v)}`} style={{ fontSize: 10, cursor: "default" }}>
                  {k}: {String(v)}
                </span>
              ))}
            </div>
          ) : (
            <span className="faint">no custom fields</span>
          )}
        </td>
        <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
          <PayloadBlock raw={r.rawPayload} parsed={r.parsedPayload} />
        </td>
      </tr>
    </>
  );
}

/** The full raw body (spec 4) — pretty-printed when parseable, raw text when
 *  not (never a crash, never an invented payload). */
function PayloadBlock({ raw, parsed }: { raw: string; parsed: Record<string, unknown> | null }) {
  return parsed ? (
    <details>
      <summary className="faint" style={{ fontSize: 11, cursor: "pointer" }}>raw payload</summary>
      <pre className="mono" style={{ fontSize: 10, maxHeight: 220, overflow: "auto", margin: 0 }}>
        {JSON.stringify(parsed, null, 2)}
      </pre>
    </details>
  ) : (
    <details>
      <summary className="faint" style={{ fontSize: 11, cursor: "pointer" }}>raw body (unparseable)</summary>
      <pre className="mono" style={{ fontSize: 10, maxHeight: 220, overflow: "auto", margin: 0 }}>
        {raw}
      </pre>
    </details>
  );
}

function kindLabel(k: FlexiLeadRow["eventKind"]) {
  return k === "registered" ? "Lead capture" : k === "payment_success" ? "Purchase" : k === "payment_failed" ? "Payment failed" : k === "refund" ? "Refund" : "Event";
}
function kindTone(k: FlexiLeadRow["eventKind"]) {
  return k === "registered" ? "good" : k === "payment_success" ? "accent" : k === "refund" ? "warn" : k === "payment_failed" ? "bad" : "";
}
