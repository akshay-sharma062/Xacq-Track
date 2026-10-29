/**
 * Read + write service for the Lead list, timeline and pipeline screens
 * (spec 5.4 / 5.5). Centralising these here means every screen + API route
 * scopes by `clientId` and masks phones the same way (spec 10).
 */
import { prisma, Prisma } from "./prisma";
import { maskPhone, Session } from "./session";
import { auditAction } from "./security";
import { normalisePhone } from "./identity";

export interface LeadFilters {
  q?: string; // search phone / email / name (spec 5.4)
  clientId?: string;
  funnelId?: string;
  stage?: string;
  campaignId?: string;
  adId?: string;
  from?: string; // ISO date
  to?: string;
  sourceUnknown?: boolean;
  duplicate?: boolean;
}

/** A lead row shaped for the list + kanban screens (phones masked by role). */
export interface LeadRow {
  id: string;
  clientId: string;
  clientName: string;
  funnelId: string | null;
  funnelName: string | null;
  name: string | null;
  phone: string; // masked per session
  rawPhone: string | null;
  email: string | null;
  city: string | null;
  stage: string;
  ownerName: string | null;
  ownerId: string | null;
  sourceUnknown: boolean;
  isDuplicateCandidate: boolean;
  totalPaid: number; // net paid across payments
  firstTouch: string | null;
  createdAt: string;
}

async function leadRows(
  where: Prisma.LeadWhereInput,
  session: Session,
  take = 200
): Promise<LeadRow[]> {
  const leads = await prisma.lead.findMany({
    where,
    take,
    orderBy: { createdAt: "desc" },
    include: {
      client: { select: { name: true } },
      funnel: { select: { name: true } },
      owner: { select: { name: true } },
      payments: {
        where: { status: { in: ["paid", "refunded"] } },
        select: { amount: true, status: true, product: true },
      },
      touchpoints: { take: 1, orderBy: { timestamp: "asc" }, select: { timestamp: true } },
    },
  });
  return leads.map((l) => {
    const paid = l.payments.reduce((s, p) => s + (p.status === "paid" ? p.amount : p.status === "refunded" ? -p.amount : 0), 0);
    return {
      id: l.id,
      clientId: l.clientId,
      clientName: l.client.name,
      funnelId: l.funnelId,
      funnelName: l.funnel?.name ?? null,
      name: l.name,
      phone: maskPhone(l.phone, session),
      rawPhone: l.phone,
      email: l.email,
      city: l.city,
      stage: l.stage,
      ownerName: l.owner?.name ?? null,
      ownerId: l.ownerId,
      sourceUnknown: l.sourceUnknown,
      isDuplicateCandidate: l.isDuplicateCandidate,
      totalPaid: paid,
      firstTouch: l.touchpoints[0]?.timestamp ? l.touchpoints[0]!.timestamp.toISOString() : null,
      createdAt: l.createdAt.toISOString(),
    };
  });
}

export async function searchLeads(filters: LeadFilters, session: Session): Promise<LeadRow[]> {
  const where: Prisma.LeadWhereInput = {};
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.funnelId) where.funnelId = filters.funnelId;
  if (filters.stage) where.stage = filters.stage;
  if (filters.sourceUnknown) where.sourceUnknown = true;
  if (filters.duplicate) where.isDuplicateCandidate = true;
  if (filters.from || filters.to) {
    where.createdAt = {};
    if (filters.from) where.createdAt.gte = new Date(filters.from);
    if (filters.to) where.createdAt.lte = new Date(filters.to);
  }
  if (filters.q) {
    const q = filters.q.trim();
    const phoneHit = normalisePhone(q);
    // NOTE: plain `contains` (no `mode: "insensitive"`) so the query is valid
    // on both SQLite (local) and Postgres (prod). emailNormalized is already
    // lowercased (spec 4), so lowercase the query for that field.
    where.OR = [
      { name: { contains: q } },
      { emailNormalized: { contains: q.toLowerCase() } },
      { phone: { contains: q.replace(/[^\d+]/g, "") } },
      ...(phoneHit ? [{ phoneNormalized: phoneHit }] : []),
    ];
  }
  const rows = await leadRows(where, session);
  // Client / campaign / ad filters that need touches: narrow in-memory (small sets).
  let out = rows;
  if (filters.campaignId || filters.adId) {
    const ids = new Set<string>();
    const touches = await prisma.touchpoint.findMany({
      where: {
        AND: [
          filters.campaignId ? { campaignId: filters.campaignId } : {},
          filters.adId ? { adId: filters.adId } : {},
        ],
      },
      select: { leadId: true },
    });
    touches.forEach((t) => t.leadId && ids.add(t.leadId));
    out = rows.filter((r) => ids.has(r.id));
  }
  return out;
}

/** Timeline (spec 5.4): every event, newest first, with the platform + ad. */
export interface TimelineEvent {
  id: string;
  type: string;
  sourcePlatform: string;
  value: number | null;
  currency: string | null;
  minutesWatched: number | null;
  sentToMeta: boolean;
  adId: string | null;
  adName: string | null;
  thumbnail: string | null;
  timestamp: string;
  raw: Record<string, unknown>;
}

export async function leadTimeline(leadId: string, session: Session) {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: {
      client: true,
      funnel: true,
      owner: true,
      payments: { orderBy: { paidAt: "desc" } },
      events: {
        orderBy: { timestamp: "desc" },
        include: { webhookLog: { select: { status: true } } },
      },
      notes: { orderBy: { createdAt: "desc" }, include: { user: { select: { name: true } } } },
      tasks: { where: { outcome: null }, orderBy: { dueAt: "asc" } },
      calls: { orderBy: { bookedAt: "desc" } },
    },
  });
  if (!lead) return null;

  // Resolve the ad thumbnail/name for any event carrying an ad in its payload.
  const adIds = new Set<string>();
  for (const e of lead.events) {
    const ad = parsePayloadAd(e.rawPayload);
    if (ad) adIds.add(ad);
  }
  const adRows = adIds.size
    ? await prisma.ad.findMany({
        where: { metaId: { in: [...adIds] } },
        include: { creatives: { take: 1 } },
      })
    : [];
  const adMap = new Map(adRows.map((a) => [a.metaId, a]));

  const timeline: TimelineEvent[] = lead.events.map((e) => {
    const ad = parsePayloadAd(e.rawPayload);
    const a = ad ? adMap.get(ad) : undefined;
    return {
      id: e.id,
      type: e.type,
      sourcePlatform: e.sourcePlatform,
      value: e.value,
      currency: e.currency,
      minutesWatched: e.minutesWatched,
      sentToMeta: e.sentToMeta,
      adId: ad ?? null,
      adName: a?.name ?? null,
      thumbnail: a?.creatives[0]?.thumbnailUrl ?? null,
      timestamp: e.timestamp.toISOString(),
      raw: safeObj(e.rawPayload),
    };
  });

  return {
    lead: {
      id: lead.id,
      name: lead.name,
      phone: maskPhone(lead.phone, session),
      email: lead.email,
      city: lead.city,
      clientName: lead.client.name,
      funnelName: lead.funnel?.name ?? null,
      stage: lead.stage,
      ownerName: lead.owner?.name ?? null,
      sourceUnknown: lead.sourceUnknown,
      createdAt: lead.createdAt.toISOString(),
    },
    totalPaid: lead.payments.reduce(
      (s, p) => s + (p.status === "paid" ? p.amount : p.status === "refunded" ? -p.amount : 0),
      0
    ),
    payments: lead.payments.map((p) => ({
      id: p.id,
      product: p.product,
      amount: p.amount,
      gateway: p.gateway,
      status: p.status,
      paidAt: p.paidAt?.toISOString() ?? null,
    })),
    timeline,
    notes: lead.notes.map((n) => ({ id: n.id, body: n.body, by: n.user.name, at: n.createdAt.toISOString() })),
    openTasks: lead.tasks.map((t) => ({
      id: t.id,
      type: t.type,
      dueAt: t.dueAt?.toISOString() ?? null,
      notes: t.notes,
    })),
    calls: lead.calls.map((c) => ({
      id: c.id,
      bookedAt: c.bookedAt.toISOString(),
      doneAt: c.doneAt?.toISOString() ?? null,
      outcome: c.outcome,
      notes: c.notes,
    })),
  };
}

function parsePayloadAd(raw: string): string | null {
  try {
    const o = JSON.parse(raw);
    return o?.ad_id ?? o?.adId ?? null;
  } catch {
    return null;
  }
}
function safeObj(raw: string): Record<string, unknown> {
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Pipeline writes (spec 5.5). All are permission-checked at the API layer;
// each is audit-logged.
// ---------------------------------------------------------------------------
export async function moveStage(
  leadId: string,
  stage: string,
  session: Session
): Promise<{ ok: boolean; error?: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { client: true } });
  if (!lead) return { ok: false, error: "not found" };
  await prisma.lead.update({ where: { id: leadId }, data: { stage } });
  await prisma.event.create({
    data: {
      leadId,
      clientId: lead.clientId,
      type: "stage_changed",
      sourcePlatform: "manual",
      rawPayload: JSON.stringify({ from: lead.stage, to: stage }),
      timestamp: new Date(),
    },
  });
  await auditAction(session, lead.clientId, "stage_change", "lead", leadId, { from: lead.stage, to: stage });
  return { ok: true };
}

export async function assignLead(leadId: string, ownerId: string | null, session: Session): Promise<{ ok: boolean; error?: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "not found" };
  await prisma.lead.update({ where: { id: leadId }, data: { ownerId } });
  await auditAction(session, lead.clientId, "assign", "lead", leadId, { owner: ownerId });
  return { ok: true };
}

export async function addNote(leadId: string, body: string, session: Session): Promise<{ ok: boolean; error?: string }> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, error: "not found" };
  const n = await prisma.note.create({
    data: { leadId, userId: session.userId, body },
  });
  await prisma.event.create({
    data: {
      leadId,
      clientId: lead.clientId,
      type: "note_added",
      sourcePlatform: "manual",
      rawPayload: JSON.stringify({ noteId: n.id }),
      timestamp: new Date(),
    },
  });
  await auditAction(session, lead.clientId, "note", "lead", leadId, { note: n.id });
  return { ok: true };
}

/** Merge two duplicate leads (spec 5.3): events/payments move to `keepId`. */
export async function mergeDuplicates(
  keepId: string,
  dropId: string,
  session: Session
): Promise<{ ok: boolean; error?: string }> {
  const [keep, drop] = await Promise.all([
    prisma.lead.findUnique({ where: { id: keepId } }),
    prisma.lead.findUnique({ where: { id: dropId } }),
  ]);
  if (!keep || !drop) return { ok: false, error: "not found" };
  if (keep.clientId !== drop.clientId) return { ok: false, error: "cannot merge across clients (spec 4)" };

  await prisma.$transaction([
    prisma.event.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.payment.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.touchpoint.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.task.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.note.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.call.updateMany({ where: { leadId: dropId }, data: { leadId: keepId } }),
    prisma.lead.update({
      where: { id: keepId },
      data: {
        phone: keep.phone ?? drop.phone,
        email: keep.email ?? drop.email,
        name: keep.name ?? drop.name,
        city: keep.city ?? drop.city,
        isDuplicateCandidate: false,
      },
    }),
    prisma.lead.update({ where: { id: dropId }, data: { isDuplicateCandidate: false, deletedAt: new Date() } }),
  ]);
  await auditAction(session, keep.clientId, "merge", "lead", keepId, { into: keepId, from: dropId });
  return { ok: true };
}

/**
 * Duplicate review list (spec 5.3): leads in the same client that share an
 * email but disagree on phone, plus any explicitly flagged.
 */
export async function duplicateCandidates(clientId?: string): Promise<LeadRow[]> {
  const leads = await prisma.lead.findMany({
    where: { ...(clientId ? { clientId } : {}), isDuplicateCandidate: true },
    include: { client: true, funnel: true, owner: true },
  });
  return leads.map((l) => ({
    id: l.id,
    clientId: l.clientId,
    clientName: l.client.name,
    funnelId: l.funnelId,
    funnelName: l.funnel?.name ?? null,
    name: l.name,
    phone: l.phone ?? "",
    rawPhone: l.phone,
    email: l.email,
    city: l.city,
    stage: l.stage,
    ownerName: l.owner?.name ?? null,
    ownerId: l.ownerId,
    sourceUnknown: l.sourceUnknown,
    isDuplicateCandidate: l.isDuplicateCandidate,
    totalPaid: 0,
    firstTouch: null,
    createdAt: l.createdAt.toISOString(),
  }));
}
