/**
 * Lead detail + timeline (spec 5.4) and pipeline mutations (spec 5.5):
 *   GET   /api/leads/:id            -> lead, source card, timeline, notes, tasks
 *   PATCH /api/leads/:id            -> stage / owner / notes
 *   POST  /api/leads/:id/merge      -> merge a duplicate into this lead
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/api-utils";
import { leadTimeline, moveStage, assignLead, addNote, mergeDuplicates } from "@/lib/leads";
import { can, visibleClients } from "@/lib/session";

async function leadGate(id: string, session: Awaited<ReturnType<typeof getSession>>) {
  if (!session) return { bad: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  const row = await prisma.lead.findUnique({ where: { id }, select: { clientId: true } });
  if (!row) return { bad: NextResponse.json({ error: "not found" }, { status: 404 }) };
  const visible = await visibleClients(session);
  if (!visible.includes(row.clientId)) {
    return { bad: NextResponse.json({ error: "client not visible to this user" }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const gate = await leadGate(id, s);
  if (gate.bad) return gate.bad;
  const data = await leadTimeline(id, s);
  if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(data);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const gate = await leadGate(id, s);
  if (gate.bad) return gate.bad;

  const b = await req.json().catch(() => ({}));
  let out: { ok: boolean; error?: string };

  if (b.note) {
    if (!can(s, "add_note")) return NextResponse.json({ error: "forbidden: add_note" }, { status: 403 });
    out = await addNote(id, String(b.note), s);
  } else if (b.stage) {
    if (!can(s, "move_stage")) return NextResponse.json({ error: "forbidden: move_stage" }, { status: 403 });
    out = await moveStage(id, String(b.stage), s);
  } else if (b.ownerId !== undefined) {
    if (!can(s, "assign_lead")) return NextResponse.json({ error: "forbidden: assign_lead" }, { status: 403 });
    out = await assignLead(id, b.ownerId ?? null, s);
  } else {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  if (!out.ok) return NextResponse.json(out, { status: 400 });
  return NextResponse.json(out);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await params;
  const gate = await leadGate(id, s);
  if (gate.bad) return gate.bad;

  const b = await req.json().catch(() => ({}));
  if (!can(s, "merge_duplicate")) return NextResponse.json({ error: "forbidden: merge_duplicate" }, { status: 403 });
  const out = await mergeDuplicates(id, String(b.dropId ?? ""), s);
  if (!out.ok) return NextResponse.json(out, { status: 400 });
  return NextResponse.json(out);
}
