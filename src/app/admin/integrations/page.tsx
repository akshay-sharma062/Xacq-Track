import { Topbar } from "../../components/Topbar";
import { getSession } from "@/lib/api-utils";
import { can } from "@/lib/session";
import { adapterCatalog } from "@/lib/adapters";
import { prisma } from "@/lib/prisma";
import { IntegrationsPanel } from "./IntegrationsPanel";

/**
 * D-13 — Webhook & API key management panel (admin-only). The PO's
 * FlexiFunnels case: no provider API key, only a webhook URL we point the
 * provider at, with a per-CONNECTION secret (multiple connections per
 * client×platform: two FlexiFunnels accounts, two Razorpay test+prod, …).
 *
 * Gating is enforced at the API layer via the `admin_integrations`
 * permission (owner + admin only — see src/lib/session.ts); this screen is
 * additionally hidden for non-admins here so a portal role never sees it.
 * Hash-only key storage + one-time secret reveal live in the panel; the
 * platform dropdown is the ADAPTERS catalog (DB-driven), not hardcoded.
 */
export const dynamic = "force-dynamic";

export default async function AdminIntegrationsPage() {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Integrations admin" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  if (!can(s, "admin_integrations")) {
    return (
      <>
        <Topbar title="Integrations admin" crumb={s.name} />
        <div className="card empty">
          This panel is admin-only (the <code>admin_integrations</code> permission: owner /
          admin). Sign in as an admin persona to manage API keys and webhook
          connections.
        </div>
      </>
    );
  }

  // The platform dropdown source: the adapter catalog (every spec §6 platform),
  // NOT a hardcoded list — a new adapter shows up here automatically.
  const platforms = adapterCatalog().map((a) => ({ platform: a.platform, label: a.label }));

  // Client dropdown: every client in this session's workspace (the
  // admin/owner role = empty clientAccess = "all clients in the workspace",
  // matching the API routes' resolveClientSet scoping). Workspace-scoped so a
  // multi-workspace setup never leaks other workspaces' clients here.
  const clients = await prisma.client.findMany({
    where: { workspaceId: s.workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <Topbar title="Webhooks & API keys" crumb="D-13 · multiple connections per client×platform" />
      <IntegrationsPanel
        platforms={platforms}
        clients={clients.map((c) => ({ id: c.id, name: c.name }))}
      />
    </>
  );
}
