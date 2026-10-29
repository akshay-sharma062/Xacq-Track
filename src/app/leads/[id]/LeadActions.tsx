"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

const STAGES = ["New", "Registered", "Attended", "Hot", "Call Booked", "Paid", "Lost"];

/**
 * Pipeline mutations for a lead (spec 5.5): move stage (auto-moves are
 * already handled by the ingest pipeline; this is the manual override) and add
 * a note. Both call the PATCH /api/leads/:id route, which enforces role
 * permissions + audit-logs the change.
 */
export function LeadActions({
  leadId,
  stage,
  canStage,
  canNote,
}: {
  leadId: string;
  stage: string;
  canStage: boolean;
  canNote: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  async function move(newStage: string) {
    start(async () => {
      const r = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: newStage }),
      });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? `moved to ${newStage}` : j.error ?? "error");
      router.refresh();
    });
  }

  async function addNote() {
    if (!note.trim()) return;
    start(async () => {
      const r = await fetch(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim() }),
      });
      const j = await r.json().catch(() => ({}));
      setMsg(r.ok ? "note added" : j.error ?? "error");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="card">
      <h3>Update lead</h3>
      <div className="stack">
        {canStage ? (
          <div className="row">
            <span className="muted" style={{ fontSize: 12 }}>Move to stage</span>
            <select value={stage} onChange={(e) => move(e.target.value)} style={{ flex: 1 }}>
              {STAGES.map((s2) => (
                <option key={s2} value={s2}>
                  {s2}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {canNote ? (
          <div className="row">
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note…"
              style={{ flex: 1 }}
            />
            <button className="btn sm" onClick={addNote} disabled={pending}>
              Add
            </button>
          </div>
        ) : null}
        {msg ? <span className="faint" style={{ fontSize: 12 }}>{msg}</span> : null}
      </div>
    </div>
  );
}
