import { Topbar } from "../components/Topbar";
import { getSession, resolveClient, webhookStats, qs } from "@/lib/api-utils";
import { ADAPTERS } from "@/lib/adapters";
import { prisma } from "@/lib/prisma";
import { ist } from "../components/ui";
import { TestButton } from "./TestButton";

/**
 * Screen 6 — Integrations hub (spec 5.6). One inbound URL per client per
 * platform (with a shared secret), the mapping notes, the full webhook log
 * with status + retry, and a test button that sends a fake event per platform.
 */
export const dynamic = "force-dynamic";

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Integrations" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Integrations" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const client = await prisma.client.findUnique({ where: { id: clientId } });
  const stats = await webhookStats(clientId);
  const logs = await prisma.webhookLog.findMany({
    where: { clientId },
    orderBy: { receivedAt: "desc" },
    take: 40,
  });
  const platforms = Object.values(ADAPTERS);

  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";

  return (
    <>
      <Topbar title="Integrations hub" crumb={`${client?.name} · ${stats.total} webhooks · ${stats.failed} failed`} />

      <div className="card mb">
        <div className="row spread">
          <div>
            <h3 style={{ margin: 0 }}>Inbound webhooks</h3>
            <div className="muted" style={{ fontSize: 12 }}>
              One URL per platform. POST the platform&apos;s payload to the URL; verify with the
              shared secret (spec 10). Raw payloads are logged for re-processing (spec 4).
            </div>
          </div>
          <div className="mono" style={{ fontSize: 12 }}>
            secret: <span className="accent">{client?.webhookSecret ?? "(none)"}</span>
          </div>
        </div>
      </div>

      <div className="grid cols-2 mb">
        {platforms.map((a) => {
          const url = `${base}/api/webhooks/${a.platform}?client=${clientId}`;
          return (
            <div className="card" key={a.platform}>
              <div className="row spread mb">
                <div>
                  <strong>{a.label}</strong>
                  <div className="faint mono" style={{ fontSize: 11 }}>
                    /api/webhooks/{a.platform}
                  </div>
                </div>
                <TestButton platform={a.platform} clientId={clientId} />
              </div>
              <div className="faint" style={{ fontSize: 11 }}>
                {a.verify ? "verifies signature / shared secret" : "no signature (dev)"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>Webhook log (newest first)</h3>
        <table className="tbl">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Status</th>
              <th>Retries</th>
              <th>Error</th>
              <th style={{ textAlign: "right" }}>Received</th>
            </tr>
          </thead>
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  No webhooks logged yet for this client.
                </td>
              </tr>
            )}
            {logs.map((w) => (
              <tr key={w.id}>
                <td className="mono" style={{ fontSize: 12 }}>
                  {w.platform}
                </td>
                <td>
                  <span className={`badge ${w.status === "processed" ? "good" : w.status === "failed" ? "bad" : w.status === "duplicate" ? "warn" : ""}`}>
                    {w.status}
                  </span>
                </td>
                <td className="muted">{w.retryCount}</td>
                <td className="faint" style={{ fontSize: 12, maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {w.error ?? "—"}
                </td>
                <td style={{ textAlign: "right" }} className="faint">
                  {ist(w.receivedAt.toISOString())}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
