"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Row {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  city: string | null;
  stage: string;
}

/**
 * Merge two duplicate leads. The user picks which to keep; the POST sends
 * { dropId } to /api/leads/<keepId> which runs mergeDuplicates (spec 5.3) —
 * permission-checked + audit-logged at the API layer.
 */
export function MergePair({ group }: { group: Row[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [keep, setKeep] = useState(group[0]?.id ?? "");

  async function merge() {
    if (group.length < 2) return;
    const dropId = group.find((g) => g.id !== keep)?.id;
    if (!dropId) return;
    start(async () => {
      const r = await fetch(`/api/leads/${keep}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropId }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        setDone(j.error ? j.error : "merged");
        router.refresh();
      } else {
        setDone(j.error ?? `error ${r.status}`);
      }
    });
  }

  if (group.length < 2) return null;

  return (
    <div className="card">
      <div className="row mb">
        <strong>Same email: {group[0]?.email}</strong>
        {done ? <span className={`badge ${done === "merged" ? "good" : "warn"}`}>{done}</span> : null}
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 90 }}>Keep</th>
            <th>Name</th>
            <th>Phone</th>
            <th>City</th>
            <th>Stage</th>
          </tr>
        </thead>
        <tbody>
          {group.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="radio"
                  name={`pair-${group[0]?.id}`}
                  checked={keep === l.id}
                  onChange={() => setKeep(l.id)}
                />
              </td>
              <td>{l.name}</td>
              <td className="mono">{l.phone}</td>
              <td className="muted">{l.city}</td>
              <td>
                <span className={`stage ${l.stage}`}>{l.stage}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!done || done === "merged" ? (
        <div className="row mt">
          <button className="btn primary" onClick={merge} disabled={pending}>
            Merge (move data to the kept lead)
          </button>
          {pending ? <span className="faint">working…</span> : null}
        </div>
      ) : null}
    </div>
  );
}
