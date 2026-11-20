import { Topbar } from "../components/Topbar";
import { getSession, qs } from "@/lib/api-utils";
import { can } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { DeviceTrackPanel } from "./DeviceTrackPanel";

/**
 * Screen — "Device Track" (D-17 / the merged visitor-tracker MVP): visitor +
 * lead analytics for the FlexiFunnels landing pages, ACROSS ALL CLIENTS.
 *
 *   - Every row of data is a tracked LANDING-PAGE project (one per landing
 *     page the PO tracks). The Topbar's client switcher (the existing
 *     `?client=`) narrows the all-clients aggregate to one client's projects;
 *     a `?project=` drill-down scopes to a single landing page.
 *   - Device / browser / OS / country distributions, the visitor table, the
 *     IP analytics + CSV export, and the LEAD capture (MVP parity: form
 *     submit / thank-you page → a "lead" event + conversion-rate KPI).
 *
 * Gating is enforced at the API layer via the `admin_tracker` permission
 * (owner/admin — src/lib/session.ts); the screen hides for non-admins here so
 * a portal role never sees it. The public tracker script + ingest are
 * separate (src/lib/tracker.ts + /api/tracker/ingest — no auth, the script's
 * public endpoint).
 */
export const dynamic = "force-dynamic";

export default async function DeviceTrackPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Device Track" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  if (!can(s, "admin_tracker")) {
    return (
      <>
        <Topbar title="Device Track" crumb={s.name} />
        <div className="card empty">
          This panel is admin-only (the <code>admin_tracker</code> permission:
          owner / admin). Sign in as an admin persona to manage tracking
          projects and view the visitor / lead analytics.
        </div>
      </>
    );
  }

  const sp = qs(await searchParams);

  // The client dropdown for the "new tracking project" form: every client in
  // this workspace (owner/admin sees all; workspace-scoped like the API
  // routes' resolveClientSet).
  const clients = await prisma.client.findMany({
    where: { workspaceId: s.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <Topbar title="Device Track" crumb="D-17 · visitor + lead tracking across all clients" />
      <DeviceTrackPanel
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
        projectId={sp.project}
        client={sp.client === undefined || sp.client === "all" ? undefined : sp.client}
      />
    </>
  );
}
