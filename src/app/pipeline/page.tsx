import { Topbar } from "../components/Topbar";
import { inr } from "../components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { searchLeads } from "@/lib/leads";
import { prisma } from "@/lib/prisma";
import Link from "next/link";

/**
 * Screen 4 — Pipeline (spec 5.5). Kanban view of a client's leads by stage
 * (the funnel's stages), with a list fallback. Stage moves + assignment live
 * on the lead screen / API; this is the board the sales team works from.
 */
export const dynamic = "force-dynamic";

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Pipeline" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Pipeline" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const rows = await searchLeads({ clientId }, s);
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const funnel = await prisma.funnel.findFirst({ where: { clientId } });
  const stages: string[] = funnel ? safeArr(funnel.stages) : ["New", "Registered", "Attended", "Hot", "Call Booked", "Paid", "Lost"];

  const byStage = new Map<string, typeof rows>();
  for (const st of stages) byStage.set(st, []);
  for (const l of rows) {
    const st = l.stage;
    if (!byStage.has(st)) byStage.set(st, []);
    byStage.get(st)!.push(l);
  }

  return (
    <>
      <Topbar title="Pipeline" crumb={`${client?.name} · ${rows.length} leads · ${funnel?.name ?? "default funnel"}`} />

      <div className="kanban">
        {[...byStage.entries()].map(([stage, leads]) => (
          <div className="kcol" key={stage}>
            <div className="head">
              <span className={`stage ${stage}`}>{stage}</span>
              <span className="n">{leads.length}</span>
            </div>
            {leads.map((l) => (
              <Link className="kcard" key={l.id} href={`/leads/${l.id}`} style={{ display: "block", textDecoration: "none" }}>
                <div className="who">{l.name ?? l.phone}</div>
                <div className="meta">
                  {l.ownerName ? `@${l.ownerName}` : "unassigned"}
                  {l.totalPaid ? ` · ${inr(l.totalPaid)}` : ""}
                </div>
              </Link>
            ))}
          </div>
        ))}
      </div>

      <div className="card mt">
        <h3>All leads (list)</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Contact</th>
              <th>Stage</th>
              <th>Owner</th>
              <th style={{ textAlign: "right" }}>Paid</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <Link href={`/leads/${l.id}`} style={{ color: "inherit" }}>{l.name ?? "—"}</Link>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {l.phone}
                </td>
                <td>
                  <span className={`stage ${l.stage}`}>{l.stage}</span>
                </td>
                <td className="muted">{l.ownerName ?? "—"}</td>
                <td style={{ textAlign: "right" }} className="mono">
                  {l.totalPaid ? inr(l.totalPaid) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function safeArr(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
