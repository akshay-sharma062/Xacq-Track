import { Topbar } from "../components/Topbar";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { prisma } from "@/lib/prisma";

/**
 * Screen 11 — Team & roles (spec 5.10). Shows every user, their role, their
 * visible-client scoping, and phone-mask + 2FA state. Roles:
 *   Owner / Admin / Media Buyer / Sales Rep / Viewer (client portal default).
 */
export const dynamic = "force-dynamic";

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Team & roles" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Team & roles" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const users = await prisma.user.findMany({
    where: { workspaceId: s.workspaceId },
    include: { workspace: true },
  });

  const ROLE_DESC: Record<string, string> = {
    owner: "Full control + sign-off on gates",
    admin: "Everything except ownership",
    media_buyer: "Reports, CAPI, Meta pull (no phones)",
    sales_rep: "Pipeline, notes, tasks, phones",
    viewer: "Read-only client portal",
  };

  return (
    <>
      <Topbar title="Team & roles" crumb={s.workspaceId ? s.name : "Admin"} />
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Client access</th>
              <th>Phone</th>
              <th>2FA</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const access = safeParse(u.clientAccess);
              return (
                <tr key={u.id}>
                  <td>{u.name}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{u.email}</td>
                  <td>
                    <span className="badge accent">{u.role}</span>{" "}
                    <span className="faint" style={{ fontSize: 11 }}>{ROLE_DESC[u.role] ?? ""}</span>
                  </td>
                  <td className="faint" style={{ fontSize: 12 }}>{access.length ? access.join(", ") : "all in workspace"}</td>
                  <td>{u.phoneMask ? <span className="muted">masked</span> : <span className="good">full</span>}</td>
                  <td>{u.twoFactor ? <span className="good">on</span> : <span className="muted">off</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
          Roles map to the action matrix in <code>src/lib/session.ts</code>. Phone numbers are
          masked to the last 4 for roles that set <code>phoneMask</code> (spec 5.10 / 10).
        </div>
      </div>
    </>
  );
}

function safeParse(raw: string): string[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
