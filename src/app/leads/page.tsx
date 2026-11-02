import { Topbar } from "../components/Topbar";
import { inr, ist } from "../components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { searchLeads } from "@/lib/leads";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

/**
 * Screen 2 — Lead list (spec 5.4). Search + filters by client/funnel/stage/
 * campaign/ad/date. Phones are masked per the acting persona (spec 5.10).
 * This is a server component; the filters come from the query string so the
 * topbar client switcher re-scope it automatically.
 */
export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Lead list" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Lead list" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const q = typeof sp.q === "string" ? sp.q : undefined;
  const stage = typeof sp.stage === "string" ? sp.stage : undefined;
  const filters = { q, stage, funnelId: sp.funnel, from: sp.from, to: sp.to };
  const rows = await searchLeads(filters, s);
  // D-02 post-purge honesty: distinguish "no leads exist yet" (valid state
  // before G3/G4 live traffic) from "your filter matched nothing".
  const anyLeads =
    Object.values(filters).every((v) => !v)
      ? rows.length > 0
      : await prisma.lead.count({ where: { clientId } }).then((n) => n > 0);

  const client = await prisma.client.findUnique({ where: { id: clientId } });

  return (
    <>
      <Topbar title="Lead list" crumb={`${client?.name} · ${rows.length} leads`} />

      <div className="card mb">
        <form method="GET" className="row">
          <input type="hidden" name="client" value={clientId} />
          {stage ? <input type="hidden" name="stage" value={stage} /> : null}
          <input
            name="q"
            placeholder="Search phone / email / name…"
            defaultValue={q ?? ""}
            style={{ flex: 1, minWidth: 220 }}
          />
          <button className="btn primary">Search</button>
        </form>
      </div>

      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Stage</th>
              <th>Owner</th>
              <th style={{ textAlign: "right" }}>Paid</th>
              <th style={{ textAlign: "right" }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !anyLeads && (
              <tr>
                <td colSpan={6} className="empty">
                  No leads yet — live traffic starts when G3 (xt.js on
                  join.upcurvv.com/cll) and G4 (gateway webhooks) are live.
                </td>
              </tr>
            )}
            {rows.length === 0 && anyLeads && (
              <tr>
                <td colSpan={6} className="empty">
                  No leads match.
                </td>
              </tr>
            )}
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/leads/${l.id}`} style={{ color: "inherit" }}>
                    <strong>{l.name ?? "—"}</strong>
                  </Link>
                  {l.sourceUnknown ? (
                    <span className="badge warn" style={{ marginLeft: 8 }}>
                      source unknown
                    </span>
                  ) : null}
                  {l.isDuplicateCandidate ? (
                    <span className="badge bad" style={{ marginLeft: 6 }}>
                      dup
                    </span>
                  ) : null}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {l.phone}
                  <div className="faint">{l.email}</div>
                </td>
                <td>
                  <span className={`stage ${l.stage}`}>{l.stage}</span>
                </td>
                <td className="muted">{l.ownerName ?? "—"}</td>
                <td style={{ textAlign: "right" }} className={l.totalPaid > 0 ? "good mono" : "muted mono"}>
                  {l.totalPaid ? inr(l.totalPaid) : "—"}
                </td>
                <td style={{ textAlign: "right" }} className="faint">
                  {ist(l.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
