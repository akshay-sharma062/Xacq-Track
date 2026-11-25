import { Topbar } from "./Topbar";
import { AutoRefresh } from "./AutoRefresh";
import { ist, inr, Stat } from "./ui";
import { getSession, resolveClientSet, qs } from "@/lib/api-utils";
import { platformLeadsReport, PlatformLeadsPlatform, PlatformLeadRow } from "@/lib/platformLeads";
import { resolveAdAccountId, resolveAdAccountIdInSet } from "@/lib/reports";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

/**
 * D-23 — the SHARED platform-leads screen (one component, reused 3× by the
 * FlexiFunnels / Lovable / TagMango receipt tabs instead of 3 copies).
 *
 * Server component: takes `platform` + the resolved `sp` (search params),
 * runs the session / client-set / ad-account resolution EXACTLY like the
 * original /flexi-leads page, then renders: Topbar (its existing ?adAccount=
 * dropdown is the ad-account filter — zero new filter UI), AutoRefresh (60 s),
 * the KPI card row (receipts-24h, unique leads, unmatched, last receipt),
 * the receipt table (Time IST / Lead link / Event badge / Ad account +
 * attribution badge / UTM line / form-data chips / value+txn / "show raw
 * payload" <details>), and the two-case empty state (no receipts at all vs.
 * filter matched nothing).
 *
 * The per-platform raw-payload reading lives in the lib's field specs
 * (src/lib/platformLeads.ts) — this view is platform-agnostic except for
 * the label + provider name.
 */

export const PLATFORM_LEADS_META: Record<
  PlatformLeadsPlatform,
  { title: string; provider: string }
> = {
  flexifunnels: { title: "Flexi Leads", provider: "FlexiFunnels" },
  lovable: { title: "Lovable Leads", provider: "Lovable" },
  tagmango: { title: "TagMango Leads", provider: "TagMango" },
};

/** The single reusable screen body. `sp` = the page's `qs(searchParams)`
 *  (so ?client= / ?adAccount= ride the Topbar's existing dropdowns). */
export async function PlatformLeadsView({
  platform,
  sp,
}: {
  platform: PlatformLeadsPlatform;
  sp: Record<string, string | undefined>;
}) {
  const s = await getSession();
  const meta = PLATFORM_LEADS_META[platform];
  if (!s) {
    return (
      <>
        <Topbar title={meta.title} crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const clientSet = await resolveClientSet(s, sp.client ?? "all");
  if (clientSet.length === 0) {
    return (
      <>
        <Topbar title={meta.title} crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }
  const isAll = clientSet.length > 1 && (sp.client === undefined || sp.client === "all");
  const adAccountId = isAll
    ? await resolveAdAccountIdInSet(prisma, clientSet, sp.adAccount)
    : await resolveAdAccountId(prisma, clientSet[0], sp.adAccount);

  const rep = await platformLeadsReport(prisma, {
    platform,
    clientIds: clientSet,
    adAccountId,
    session: s,
  });

  // Any receipts at all in the client set (to split the two empty states).
  const anyReceipts = rep.totalReceipts > 0 || rep.rows.length > 0;
  const adAccountName = adAccountId
    ? (await prisma.adAccount.findUnique({ where: { id: adAccountId } }))?.name ?? null
    : null;

  return (
    <>
      <Topbar
        title={meta.title}
        crumb={
          `${rep.rows.length} ${meta.provider} receipts · ${rep.uniqueLeads} leads` +
          (adAccountName ? ` · ${adAccountName}` : "")
        }
      />

      <AutoRefresh dataAsOf={rep.lastReceivedAt} />

      <div className="grid cols-4 mb">
        <Stat
          label={`${meta.provider} receipts (24 h)`}
          value={rep.last24h}
          sub={`${rep.totalReceipts} total`}
          tone="accent"
        />
        <Stat label="Unique leads" value={rep.uniqueLeads} />
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
                  No {meta.provider} webhooks received yet — receipts land here
                  automatically the moment a {meta.provider} webhook hits the
                  connection (auto-refresh every 60 s).
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
              <PlatformRow key={r.logId} row={r} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function PlatformRow({ row: r }: { row: PlatformLeadRow }) {
  const utmLine = [r.utm.source, r.utm.medium, r.utm.campaign].filter(Boolean).join(" › ");
  const chips = Object.entries(r.custom);
  return (
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
        {(r.value != null || r.txnId) ? (
          <div className="mono" style={{ fontSize: 10 }}>
            {r.value != null ? `₹${inr(r.value)}` : ""}
            {r.value != null && r.txnId ? " · " : ""}
            {r.txnId ? `txn ${r.txnId}` : ""}
          </div>
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

function kindLabel(k: PlatformLeadRow["eventKind"]) {
  return k === "registered" ? "Lead capture" : k === "payment_success" ? "Purchase" : k === "payment_failed" ? "Payment failed" : k === "refund" ? "Refund" : "Event";
}
function kindTone(k: PlatformLeadRow["eventKind"]) {
  return k === "registered" ? "good" : k === "payment_success" ? "accent" : k === "refund" ? "warn" : k === "payment_failed" ? "bad" : "";
}
