import { Topbar } from "../components/Topbar";
import { getSession, resolveClient, qs } from "@/lib/api-utils";
import { duplicateCandidates } from "@/lib/leads";
import { MergePair } from "./MergePair";

/**
 * Screen 5 — Duplicates review (spec 5.3): shows likely duplicates (same
 * client, shared email, disagreeing phone) for a human to merge. Merging moves
 * all events/payments/notes to the kept lead and soft-deletes the drop lead.
 */
export const dynamic = "force-dynamic";

export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const s = await getSession();
  if (!s) {
    return (
      <>
        <Topbar title="Duplicates" crumb="Not signed in" />
        <div className="card empty">No demo user configured.</div>
      </>
    );
  }
  const sp = qs(await searchParams);
  const clientId = await resolveClient(s, sp.client);
  if (!clientId) {
    return (
      <>
        <Topbar title="Duplicates" crumb={s.name} />
        <div className="card empty">No visible client.</div>
      </>
    );
  }

  const pairs = await duplicateCandidates(clientId);
  // Group: each flagged lead is paired with its email-matched twin.
  const groups = new Map<string, typeof pairs>();
  for (const p of pairs) {
    const key = (p.email ?? p.id).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  return (
    <>
      <Topbar title="Duplicates" crumb={`${pairs.length} flagged candidates`} />
      <p className="muted">
        Likely duplicates share an email but disagree on phone (spec 5.3). A human merges
        them — never automatic. Merging is audit-logged and cannot cross clients.
      </p>
      {pairs.length === 0 ? (
        <div className="card empty">No duplicate candidates right now.</div>
      ) : (
        <div className="stack">
          {[...groups.values()].map((group, i) => (
            <MergePair key={i} group={group} />
          ))}
        </div>
      )}
    </>
  );
}
