/**
 * D-17 — Visitor Tracking & Analytics module: the data layer (Phases 3–5).
 *
 * A NEW, self-contained module — it does NOT touch the xt.js / /api/ingest
 * pipeline or any G1–G12 work (additive: 4 new tables only). The pure
 * helpers here are unit-testable without a DB (IP capture, IP masking,
 * day-bucketing); the Prisma-backed ones run against a real SQLite DB in
 * tests (the freshDb convention).
 *
 * Security (spec §10 / Phase 5):
 *   - the IP is captured SERVER-side (cf-connecting-ip first — the Cloudflare
 *     tunnel's most trusted header) and is NEVER read from the client body;
 *   - IP display in the admin screens is masked to "1.2.3.xxx" for any role
 *     other than owner/admin (maskIp);
 *   - the GeoIP path is an OFFLINE lookup seam (geoLookup) — no paid API call
 *     per request. This build ships no GeoLite2 DB (no maxmind dep), so the
 *     default stores ip + ipCountry="unknown" (recorded in DECISIONS D-17;
 *     drop in a GeoLite2 city DB behind the same seam to upgrade).
 *   - duplicate protection: a replayed event (same visitorId + sessionToken
 *     + timestamp) is a no-op (the ingest never re-counts).
 */
import { PrismaClient } from "./prisma";
import type { Session } from "./session";

// ---------------------------------------------------------------------------
// Server-side IP capture (the real IP — never a client-sent field).
// ---------------------------------------------------------------------------

/**
 * The client IP, from the SERVER's view of the request headers, in the
 * ticket's exact priority: cf-connecting-ip (the Cloudflare tunnel's real
 * client IP — most trusted when the tunnel is active) → x-real-ip →
 * the FIRST x-forwarded-for hop → remoteAddr. IPv4 + IPv6: stored raw,
 * not validated (the spec says store, don't parse).
 */
export function clientIpFromHeaders(
  h: Record<string, string | null | undefined>
): string | null {
  const ip =
    h["cf-connecting-ip"]?.trim() ||
    h["x-real-ip"]?.trim() ||
    h["x-forwarded-for"]?.split(",")[0]?.trim() ||
    h["remoteAddr"]?.trim() ||
    null;
  return ip && ip.length ? ip : null;
}

/**
 * IP display for the admin screens (Phase 5): owner/admin see the full IP;
 * every other role sees it masked to the last-octet form (spec example:
 * "1.2.3.xxx" for an IPv4, the tail for an IPv6). A null/empty IP is "—".
 */
export function maskIp(
  ip: string | null | undefined,
  session?: Pick<Session, "role">
): string {
  if (!ip) return "—";
  const privileged =
    !!session && (session.role === "owner" || session.role === "admin");
  if (privileged) return ip;
  if (ip.includes(":")) return "…:" + ip.split(":").pop(); // IPv6: last group only
  const parts = ip.split(".");
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  return ip.slice(-6);
}

// ---------------------------------------------------------------------------
// GeoIP: an offline lookup seam (never a paid API per request).
// ---------------------------------------------------------------------------

export interface GeoRecord {
  country: string;
  state: string;
  city: string;
}
export type GeoLookup = (ip: string) => GeoRecord | null;

/**
 * This build ships NO offline GeoLite2 city DB (no maxmind dep in
 * node_modules), so the lookup is a documented no-op: ip is stored,
 * ipCountry="unknown", state/city null. A GeoLite2 DB dropped behind this
 * same seam upgrades the module without touching the ingest path.
 */
export const geoLookupNone: GeoLookup = () => null;

// ---------------------------------------------------------------------------
// Ingest (Phase 3): upserts + dedup. Pure-input, testable.
// ---------------------------------------------------------------------------

export interface TrackerIngestInput {
  projectId: string;
  visitorId: string;
  sessionToken?: string | null;
  /** MVP parity: "pageview" (the default) or "lead" (a captured form submit
   *  / thank-you page). Part of the dedup key — a pageview + a lead in the
   *  same second both land; a replay of either is a no-op. */
  eventType?: string | null;
  /** WHERE a lead was captured: "thankyou" | "submit" | "click" | "ajaxSuccess"
   *  | "manual". Null on a pageview. */
  leadSource?: string | null;
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
  deviceType?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  browserName?: string | null;
  browserVer?: string | null;
  screenW?: number | null;
  screenH?: number | null;
  landingUrl?: string | null;
  pageUrl?: string | null;
  /** ISO string from the script; a bad value falls back to now(). */
  timestamp?: string | null;
}

export type TrackerIngestResult =
  | { ok: true; id: string; duplicate?: boolean }
  | { ok: false; reason: "unknown_project" | "inactive" };

/** Parse the script's timestamp; null → now() (a bad value must never 500). */
export function parseTrackerTimestamp(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Ingest ONE tracker page-visit. Idempotent by design:
 *   - unknown project  → { ok:false, reason:"unknown_project" } (route 404)
 *   - inactive project → { ok:false, reason:"inactive" }        (route 204, no rows)
 *   - replay (same visitorId + sessionToken + timestamp) → no-op
 *     (returns the existing event id, counts NEVER re-increment)
 *   - otherwise: upsert TrackedVisitor (lastSeen + totalVisits++), upsert
 *     VisitorSession (new token → new row; same token → extend endedAt),
 *     insert the VisitorEvent row with the SERVER-captured ip + the offline
 *     geo lookup (ipCountry "unknown" when the lookup is a no-op).
 */
export async function ingestTrackerEvent(
  prisma: PrismaClient,
  input: TrackerIngestInput,
  ip: string | null,
  lookup: GeoLookup = geoLookupNone
): Promise<TrackerIngestResult> {
  const project = await prisma.trackingProject.findUnique({
    where: { id: input.projectId },
  });
  if (!project) return { ok: false, reason: "unknown_project" };
  if (project.status === "inactive") return { ok: false, reason: "inactive" };

  const when = parseTrackerTimestamp(input.timestamp) ?? new Date();
  const token = input.sessionToken?.trim() ? input.sessionToken.trim() : null;
  // MVP parity: "pageview" (default) or "lead" — a lead is part of the dedup
  // key so a pageview + a lead in the same second both land, but a REPLAY of
  // the same (visitor, session, kind, instant) is a no-op.
  const evType = input.eventType === "lead" ? "lead" : "pageview";
  const leadSrc = evType === "lead" ? (input.leadSource ?? null) : null;
  const s: (typeof prisma) = prisma;

  // Duplicate protection (the dedup key: visitorId + sessionToken +
  // eventType + timestamp): a replayed POST finds this row and is a no-op.
  const dup = await s.visitorEvent.findFirst({
    where: {
      projectId: project.id,
      visitorId: input.visitorId,
      sessionToken: token,
      eventType: evType,
      timestamp: when,
    },
  });
  if (dup) return { ok: true, id: dup.id, duplicate: true };

  // TrackedVisitor upsert (the aggregate that survives retention): every
  // event (pageview OR lead) is a visit — same as the MVP's "total_visits =
  // COUNT(*) of visits rows". A new visitor increments totalVisits (so a
  // lead-only first visit still counts as "new" in the new-vs-returning KPI);
  // firstSeen is never overwritten. The LEADS KPIs read VisitorEvent.eventType
  // separately, so a lead is never double-counted as a pageview.
  let visitor = await s.trackedVisitor.findFirst({
    where: { projectId: project.id, visitorId: input.visitorId },
  });
  if (visitor) {
    visitor = await s.trackedVisitor.update({
      where: { id: visitor.id },
      data: { lastSeen: when, totalVisits: { increment: 1 } },
    });
  } else {
    visitor = await s.trackedVisitor.create({
      data: {
        projectId: project.id,
        visitorId: input.visitorId,
        firstSeen: when,
        lastSeen: when,
        totalVisits: 1,
      },
    });
  }

  // VisitorSession upsert: a per-page-visit token. A new token → a new
  // session row; the SAME token (the visitor's session resumed) extends
  // endedAt. sessionToken is @unique, so upsert is exact.
  let sessionRow: { sessionToken: string } | null = null;
  if (token) {
    sessionRow = await s.visitorSession.upsert({
      where: { sessionToken: token },
      update: { endedAt: when },
      create: {
        projectId: project.id,
        visitorId: input.visitorId,
        sessionToken: token,
        startedAt: when,
        endedAt: when,
      },
    });
  }

  const geo = ip ? lookup(ip) : null;
  const event = await s.visitorEvent.create({
    data: {
      projectId: project.id,
      visitorId: input.visitorId,
      sessionToken: sessionRow?.sessionToken ?? null,
      ip,
      // The offline seam: this build stores "unknown" (geoLookupNone) —
      // ip is kept so a later GeoLite2 drop-in can backfill.
      ipCountry: geo?.country ?? "unknown",
      ipState: geo?.state ?? null,
      ipCity: geo?.city ?? null,
      deviceType: input.deviceType ?? null,
      osName: input.osName ?? null,
      osVersion: input.osVersion ?? null,
      browserName: input.browserName ?? null,
      browserVer: input.browserVer ?? null,
      screenW: input.screenW ?? null,
      screenH: input.screenH ?? null,
      landingUrl: input.landingUrl ?? null,
      referrer: input.referrer ?? null,
      utmSource: input.utmSource ?? null,
      utmMedium: input.utmMedium ?? null,
      utmCampaign: input.utmCampaign ?? null,
      utmTerm: input.utmTerm ?? null,
      utmContent: input.utmContent ?? null,
      pageUrl: input.pageUrl ?? null,
      eventType: evType,
      leadSource: leadSrc,
      timestamp: when,
    },
  });

  void visitor;
  return { ok: true, id: event.id };
}

// ---------------------------------------------------------------------------
// Project lifecycle + dashboard queries (Phases 4–5).
// ---------------------------------------------------------------------------

/**
 * The set of TrackingProject ids in a workspace — the SCOPING axis for every
 * tracker query. The TrackerEvent/TrackedVisitor/VisitorSession tables are
 * keyed off projectId (not workspaceId), so a multi-workspace setup is kept
 * from leaking into another's dashboard by resolving this set FIRST and
 * scoping every query to `projectId IN (workspaceProjectIds)`.
 */
export async function workspaceProjectIds(
  prisma: PrismaClient,
  workspaceId: string,
  clientId?: string
): Promise<string[]> {
  // The optional `clientId` is the Device Track "filter by client" axis: an
  // empty client = every project in the workspace (the all-clients aggregate);
  // a specific client id narrows to that client's tracking projects. An
  // UNASSIGNED project (clientId null) is only in the all-clients view — never
  // under a specific client.
  const rows = await prisma.trackingProject.findMany({
    where: { workspaceId, ...(clientId ? { clientId } : {}) },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Create a tracking project (admin-only, workspace-scoped). The DB cuid
 *  is generated by Prisma's `@default(cuid())` — the route returns it. */
export async function createTrackingProject(
  prisma: PrismaClient,
  args: {
    workspaceId: string;
    name: string;
    landingPageName: string;
    landingPageUrl: string;
    description?: string | null;
    /** The client whose landing page this project tracks (the Device Track
     *  "filter by client" axis). Omitted = unassigned (all-clients view). */
    clientId?: string | null;
    createdBy: string;
  }
): Promise<{ id: string; name: string; landingPageUrl: string }> {
  const row = await prisma.trackingProject.create({
    data: {
      workspaceId: args.workspaceId,
      name: args.name.trim(),
      landingPageName: args.landingPageName.trim(),
      landingPageUrl: args.landingPageUrl.trim(),
      description: args.description?.trim() || null,
      clientId: args.clientId ?? null,
      createdBy: args.createdBy,
    },
  });
  return { id: row.id, name: row.name, landingPageUrl: row.landingPageUrl };
}

/**
 * Workspace-scoped project ids for an admin screen (the scoping axis the D-17
 * ticket wants — the tracker is a per-workspace module, and an explicit
 * `?project=` narrows to one that MUST belong to this workspace). Admin-only
 * in practice; a caller passes the `admin_tracker` session.
 */
export async function trackerScope(
  prisma: PrismaClient,
  workspaceId: string,
  projectParam?: string | null
): Promise<{ ids: string[]; error?: string }> {
  const ids = await workspaceProjectIds(prisma, workspaceId);
  if (projectParam) {
    // An explicit project id must be in THIS workspace, else it's a clean
    // "unknown project" (never a leak of another workspace's tracker data).
    return ids.includes(projectParam) ? { ids: [projectParam] } : { ids: [], error: "unknown project" };
  }
  return { ids };
}

/** The install snippet the admin sees (Phase 2 contract). `baseUrl` is the
 *  live public base (PUBLIC_BASE_URL / Workspace.liveHost), NOT a placeholder —
 *  the PO copies this verbatim into the FlexiFunnels custom-JS slot. No
 *  secret, no token: only the public project id + the public base URL. */
export function trackerInstallSnippet(projectId: string, baseUrl: string): string {
  return `<script src="${baseUrl}/tracker.js"\n  data-project="${projectId}"\n  data-api="${baseUrl}"\n  defer></script>`;
}

/** Flip a project active/inactive (the "Disable / Enable" toggle; an
 *  inactive project's ingest returns 204 and writes nothing). */
export async function setProjectStatus(
  prisma: PrismaClient,
  projectId: string,
  status: "active" | "inactive"
): Promise<{ found: boolean; status: string }> {
  const row = await prisma.trackingProject.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  if (!row) return { found: false, status: "" };
  await prisma.trackingProject.update({
    where: { id: projectId },
    data: { status },
  });
  return { found: true, status };
}

export interface ProjectSummary {
  id: string;
  name: string;
  landingPageName: string;
  landingPageUrl: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  eventCount: number;
  lastEventAt: Date | null;
  /** The client this project tracks + its name (the Device Track "by
   *  client" column). Null = an unassigned project. */
  clientId: string | null;
  clientName: string | null;
}

/**
 * Normalise a raw-SQL SQLite timestamp value to a JS Date. The SQLite driver
 * returns `MAX(timestamp)` as a **BigInt of unix-ms** (a Prisma raw-query
 * int64), while plain column reads come back as Date objects and some
 * drivers return the ISO string — `new Date(bigint)` throws
 * "Cannot convert a BigInt value to a number", so every shape is handled.
 */
function rawTsToMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  const n = Number(v); // bigint + a numeric string both coerce
  if (!isNaN(n)) return n;
  const t = Date.parse(String(v)); // an ISO-8601 string form
  return isNaN(t) ? null : t;
}

/** The project list for /admin/tracker (per-project event count + last event +
 *  the owning client for the Device Track "by client" view). */
export async function trackerProjectSummaries(
  prisma: PrismaClient,
  workspaceId: string
): Promise<ProjectSummary[]> {
  const projects = await prisma.trackingProject.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "asc" },
    include: { client: { select: { id: true, name: true } } },
  });
  if (projects.length === 0) return [];
  const ids = projects.map((p) => p.id);
  const counts = await prisma.$queryRawUnsafe<
    { id: string; n: number; last: unknown }[]
  >(
    `SELECT projectId AS id, COUNT(*) AS n, MAX(timestamp) AS last
       FROM "VisitorEvent" WHERE projectId IN (${ids.map(() => "?").join(",")})
       GROUP BY projectId`,
    ...ids
  );
  const byId = new Map(counts.map((c) => [c.id, c]));
  return projects.map((p) => {
    const c = byId.get(p.id);
    const lastMs = c ? rawTsToMs(c.last) : null;
    return {
      id: p.id,
      name: p.name,
      landingPageName: p.landingPageName,
      landingPageUrl: p.landingPageUrl,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      eventCount: c ? Number(c.n) : 0,
      lastEventAt: lastMs == null ? null : new Date(lastMs),
      clientId: p.clientId,
      clientName: p.client?.name ?? null,
    };
  });
}

/**
 * The overview + project-level dashboard cards + distributions (Phase 4).
 * `projectIds` = the scope (all-projects aggregate, or one project). `now`
 * is injectable so "today" is deterministic in tests.
 */
/** One recent lead row (MVP `recentLeads` parity, newest first). */
export interface TrackerRecentLead {
  visitorId: string;
  deviceType: string | null;
  browserName: string | null;
  osName: string | null;
  ipCountry: string | null;
  ipCity: string | null;
  pageUrl: string | null;
  leadSource: string | null;
  timestamp: Date;
}

export interface TrackerDashboard {
  totalPageViews: number;
  uniqueVisitors: number;
  returningVisitors: number;
  newVisitors: number;
  todaysVisits: number;
  uniqueIps: number;
  // MVP parity: the LEAD capture KPIs. totalLeads/todayLeads count
  // VisitorEvent rows with eventType='lead' (lifetime / IST-today);
  // conversionRate = totalLeads / uniqueVisitors (0 when no visitors — never
  // a fake ratio).
  totalLeads: number;
  todayLeads: number;
  conversionRate: number;
  /** The last 50 lead events (newest first) — the "recent leads" table. */
  recentLeads: TrackerRecentLead[];
  /** Last 30 days of events, day-bucketed (UTC days, IST-labeled). */
  visitsByDay: { label: string; value: number }[];
  deviceDist: { label: string; value: number }[];
  browserDist: { label: string; value: number }[];
  osDist: { label: string; value: number }[];
  countryDist: { label: string; value: number }[];
  newVsReturning: { label: string; value: number }[];
}

/** "Today" = the start of the current IST calendar day (spec: Today's Visits, IST). */
export function startOfTodayIST(now: Date = new Date()): Date {
  const istDay = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
  return new Date(istDay + "T00:00:00+05:30");
}

export async function trackerDashboard(
  prisma: PrismaClient,
  projectIds: string[],
  opts: { now?: Date; windowDays?: number } = {}
): Promise<TrackerDashboard> {
  const now = opts.now ?? new Date();
  const windowDays = Math.max(1, opts.windowDays ?? 30);
  if (projectIds.length === 0) {
    return {
      totalPageViews: 0, uniqueVisitors: 0, returningVisitors: 0, newVisitors: 0,
      todaysVisits: 0, uniqueIps: 0, totalLeads: 0, todayLeads: 0,
      conversionRate: 0, recentLeads: [], visitsByDay: [], deviceDist: [],
      browserDist: [], osDist: [], countryDist: [],
      newVsReturning: [
        { label: "New", value: 0 },
        { label: "Returning", value: 0 },
      ],
    };
  }
  const qm = projectIds.map(() => "?").join(",");
  const today = startOfTodayIST(now);
  // The time series spans `windowDays` (the UI's date filter scopes it); the
  // CARD counts above stay lifetime totals (the spec's "Total Page Views").
  const sinceIso = new Date(now.getTime() - (windowDays - 1) * 86_400_000).toISOString();

  const [totalPageViews, totalLeads, todayLeads, uniqueVisitors, returning, fresh, todaysVisits, uniqueIpsRaw] =
    await Promise.all([
      // "Page views" = the pageview events ONLY (a lead event is a
      // conversion, not a page view) — the MVP's total_pageviews math.
      prisma.visitorEvent.count({
        where: { projectId: { in: projectIds }, eventType: "pageview" },
      }),
      prisma.visitorEvent.count({
        where: { projectId: { in: projectIds }, eventType: "lead" },
      }),
      prisma.visitorEvent.count({
        where: { projectId: { in: projectIds }, eventType: "lead", timestamp: { gte: today } },
      }),
      prisma.trackedVisitor.count({ where: { projectId: { in: projectIds } } }),
      prisma.trackedVisitor.count({
        where: { projectId: { in: projectIds }, totalVisits: { gt: 1 } },
      }),
      prisma.trackedVisitor.count({
        where: { projectId: { in: projectIds }, totalVisits: 1 },
      }),
      prisma.visitorEvent.count({
        where: { projectId: { in: projectIds }, timestamp: { gte: today } },
      }),
      prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT COUNT(DISTINCT ip) AS n FROM "VisitorEvent"
           WHERE projectId IN (${qm}) AND ip IS NOT NULL AND ip != ''`,
        ...projectIds
      ),
    ]);
  // The conversion rate = totalLeads / uniqueVisitors (the MVP's math); 0 when
  // there are no unique visitors (never a fake ratio, never divide-by-zero).
  const conversionRate = uniqueVisitors > 0
    ? Number(((totalLeads / uniqueVisitors) * 100).toFixed(2))
    : 0;

  // Distributions: raw SQL so a null bucket stays a visible "Unknown" row
  // (Prisma groupBy drops null keys; we don't silently drop that data).
  const dist = async (col: string): Promise<{ label: string; value: number }[]> => {
    const rows = await prisma.$queryRawUnsafe<{ k: string | null; n: number }[]>(
      `SELECT ${col} AS k, COUNT(*) AS n FROM "VisitorEvent"
         WHERE projectId IN (${qm}) GROUP BY ${col} ORDER BY n DESC, k ASC`,
      ...projectIds
    );
    return rows.map((r) => ({ label: r.k || "Unknown", value: Number(r.n) }));
  };
  const top10 = (r: { label: string; value: number }[]) => r.slice(0, 10);

  const [deviceDist, browserDist, osDist, countryDist, byDayRaw] = await Promise.all([
    dist("deviceType"),
    dist("browserName"),
    dist("osName"),
    top10(await dist("ipCountry")),
    prisma.$queryRawUnsafe<{ d: string; n: number }[]>(
      `SELECT date(timestamp, 'UTC') AS d, COUNT(*) AS n FROM "VisitorEvent"
         WHERE projectId IN (${qm}) AND timestamp >= ?
         GROUP BY d ORDER BY d`,
      ...projectIds,
      sinceIso
    ),
  ]);

  // `windowDays`-series with zero-fill (an empty day is an honest 0, not a gap).
  const dayMap = new Map(byDayRaw.map((r) => [r.d, Number(r.n)]));
  const visitsByDay: { label: string; value: number }[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    visitsByDay.push({
      label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }),
      value: dayMap.get(key) ?? 0,
    });
  }

  // The last 50 lead events (newest first) — the "recent leads" table
  // (MVP `recentLeads` parity). ip is the RAW value; the ROUTE masks it per
  // role before it reaches the client (spec §10).
  const recentLeads = await prisma.visitorEvent.findMany({
    where: { projectId: { in: projectIds }, eventType: "lead" },
    orderBy: { timestamp: "desc" },
    take: 50,
    select: {
      visitorId: true, deviceType: true, browserName: true, osName: true,
      ipCountry: true, ipCity: true, pageUrl: true, leadSource: true, timestamp: true,
    },
  });

  return {
    totalPageViews,
    uniqueVisitors,
    returningVisitors: returning,
    newVisitors: fresh,
    todaysVisits,
    uniqueIps: uniqueIpsRaw[0] ? Number(uniqueIpsRaw[0].n) : 0,
    totalLeads,
    todayLeads,
    conversionRate,
    recentLeads,
    visitsByDay,
    deviceDist,
    browserDist,
    osDist,
    countryDist,
    newVsReturning: [
      { label: "New", value: fresh },
      { label: "Returning", value: returning },
    ],
  };
}

// ---------------------------------------------------------------------------
// The visitor table + IP analytics + the per-visitor detail view (Phase 4).
// ---------------------------------------------------------------------------

export type VisitorKind = "new" | "returning";

export interface TrackerVisitorRow {
  visitorId: string;
  ip: string | null; // the RAW value — the ROUTE masks it per role, not here
  deviceType: string | null;
  browserName: string | null;
  osName: string | null;
  ipCountry: string | null;
  ipCity: string | null;
  firstSeen: Date;
  lastSeen: Date;
  totalVisits: number;
  kind: VisitorKind;
}

export interface VisitorQuery {
  /** IP SUFFIX match ("1.2.3") or a visitorId substring (spec: both). */
  search?: string;
  device?: string;
  country?: string;
  kind?: VisitorKind;
  /** 1-based page; the table is 25/page (spec). */
  page?: number;
  /** Page size override (the CSV export fetches the WHOLE table = a big page). */
  pageSize?: number;
}

export interface VisitorPage {
  rows: TrackerVisitorRow[];
  total: number;
  page: number;
  pageSize: number;
}

const PAGE_SIZE = 25;

export async function trackerVisitors(
  prisma: PrismaClient,
  projectIds: string[],
  q: VisitorQuery = {}
): Promise<VisitorPage> {
  const page = Math.max(1, q.page ?? 1);
  const pageSize = Math.max(1, q.pageSize ?? PAGE_SIZE);
  const where: Record<string, unknown> = { projectId: { in: projectIds } };
  const visitors = await prisma.trackedVisitor.findMany({
    where,
    // sort: totalVisits desc default (spec); the search filters apply too.
    orderBy: { totalVisits: "desc" },
  });

  // The search: an IP suffix ("1.2.3" matches a stored "…1.2.3") OR a
  // visitorId substring. The table is small per project; filter in JS on
  // the per-visitor last-event attributes (an index scan would need the
  // IP on TrackedVisitor, which the spec's schema keeps on the event rows).
  let rows = visitors.map((v) => ({
    visitorId: v.visitorId,
    ip: null as string | null,
    deviceType: null as string | null,
    browserName: null as string | null,
    osName: null as string | null,
    ipCountry: null as string | null,
    ipCity: null as string | null,
    firstSeen: v.firstSeen,
    lastSeen: v.lastSeen,
    totalVisits: v.totalVisits,
    kind: (v.totalVisits === 1 ? "new" : "returning") as VisitorKind,
  }));

  // The LATEST event per visitor carries the current device/browser/ip.
  for (const v of rows) {
    const last = await prisma.visitorEvent.findFirst({
      where: { projectId: { in: projectIds }, visitorId: v.visitorId },
      orderBy: { timestamp: "desc" },
      select: {
        ip: true, deviceType: true, browserName: true, osName: true,
        ipCountry: true, ipCity: true,
      },
    });
    if (last) Object.assign(v, last);
  }

  const s = (q.search ?? "").trim().toLowerCase();
  if (s) {
    rows = rows.filter(
      (v) =>
        (v.ip && v.ip.toLowerCase().includes(s)) ||
        v.visitorId.toLowerCase().includes(s)
    );
  }
  if (q.device) rows = rows.filter((v) => (v.deviceType ?? "unknown") === q.device);
  if (q.country) rows = rows.filter((v) => (v.ipCountry ?? "unknown") === q.country);
  if (q.kind) rows = rows.filter((v) => v.kind === q.kind);

  // totalVisits desc is the sort the spec pins; a stable tiebreak on lastSeen.
  rows.sort((a, b) => b.totalVisits - a.totalVisits || b.lastSeen.getTime() - a.lastSeen.getTime());
  const total = rows.length;
  return {
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}

/** IP analytics (the "IP analytics tab"): one IP (suffix search) → its events. */
export interface IpAnalytics {
  ip: string | null;
  eventCount: number;
  uniqueVisitors: number;
  firstSeen: Date | null;
  lastSeen: Date | null;
  deviceBreakdown: { label: string; value: number }[];
}

export async function trackerIpAnalytics(
  prisma: PrismaClient,
  projectIds: string[],
  ipSuffix: string
): Promise<IpAnalytics> {
  const like = `%${ipSuffix.trim()}`;
  const rows = await prisma.visitorEvent.findMany({
    where: { projectId: { in: projectIds }, ip: { contains: ipSuffix.trim() } },
    select: { ip: true, visitorId: true, deviceType: true, timestamp: true },
  });
  void like;
  const visitors = new Set(rows.map((r) => r.visitorId).filter(Boolean));
  const device = new Map<string, number>();
  for (const r of rows) {
    const k = r.deviceType || "Unknown";
    device.set(k, (device.get(k) ?? 0) + 1);
  }
  let first: Date | null = null;
  let last: Date | null = null;
  for (const r of rows) {
    if (!first || r.timestamp < first) first = r.timestamp;
    if (!last || r.timestamp > last) last = r.timestamp;
  }
  const ip = rows[0]?.ip ?? null;
  return {
    ip,
    eventCount: rows.length,
    uniqueVisitors: visitors.size,
    firstSeen: first,
    lastSeen: last,
    deviceBreakdown: [...device.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
  };
}

/** The per-visitor detail view: that visitorId's events, chronological. */
export async function trackerVisitorEvents(
  prisma: PrismaClient,
  projectIds: string[],
  visitorId: string
) {
  return prisma.visitorEvent.findMany({
    where: { projectId: { in: projectIds }, visitorId },
    orderBy: { timestamp: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Retention (Phase 5): TRACKER_RETENTION_DAYS — the raw events prune, the
// TrackedVisitor aggregates survive (they are the count, not the raw data).
// ---------------------------------------------------------------------------

/**
 * Delete VisitorEvent rows older than `days` (across projects); TrackedVisitor
 * rows are kept. `now` is injectable for the test. Returns rows deleted.
 */
export async function cleanTrackerRetention(
  prisma: PrismaClient,
  days: number,
  now: Date = new Date()
): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const res = await prisma.visitorEvent.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });
  return res.count;
}
