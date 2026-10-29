import { Topbar } from "../components/Topbar";
import { ist } from "../components/ui";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

/**
 * Screen 12 — Audit log (spec 5.10 / 10): who viewed, exported or changed
 * what. Every export + phone access + stage change + merge is recorded by
 * src/lib/security. Reads are scoped to the acting session's visible client.
 */
export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Audit log" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Audit log" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const rows = await prisma.auditLog.findMany({
    where: { clientId, ...(typeof sp.action === "string" ? { action: sp.action } : {}) },
    include: { user: { select: { name: true, email: true, role: true } } },
    orderBy: { at: "desc" },
    take: 200,
  });

  return (
    <>
      <Topbar title="Audit log" crumb={`${rows.length} entries`} />
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ textAlign: "right" }}>When (IST)</th>
              <th>Who</th>
              <th>Action</th>
              <th>Entity</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No audit entries for this client.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ textAlign: "right", fontSize: 12 }} className="faint mono">
                  {ist(r.at.toISOString())}
                </td>
                <td>
                  {r.user.name} <span className="faint">({r.user.role})</span>
                </td>
                <td>
                  <span className={`badge ${r.action === "export" ? "warn" : r.action === "stage_change" || r.action === "merge" ? "accent" : ""}`}>
                    {r.action}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.entity} {r.entityId ? `· ${r.entityId}` : ""}
                </td>
                <td className="faint mono" style={{ fontSize: 11, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                  {r.details}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
