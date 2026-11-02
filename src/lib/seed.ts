/**
 * Minimal bootstrap (D-01/D-02, 2026-10-30 — "ad-account recentering + seed
 * purge"). Per the product-owner decision, dev data starts from ONE real
 * source: the G1-pulled Meta ad account Upcurvv-FML
 * (act_4749960348632164, INR). `pnpm db:seed` now creates ONLY:
 *
 *   - the workspace + the two Foremost Leads staff users (owner + admin),
 *   - the client `cl_upcurvv` (named after the ad-account owner),
 *   - the ad-account link row for act_4749960348632164 (empty scaffold —
 *     real campaigns/ads/spend arrive via the G1 pull job, never via seed).
 *
 * NO leads, NO events, NO payments, NO fake spend. A 0-lead dashboard is a
 * valid state: live traffic starts when G3 (xt.js on join.upcurvv.com/cll)
 * and G4 (gateway webhooks) go live.
 *
 * The old rich fixture set (cl_fitness/cl_iitprep/cl_trial_saas + 12 leads +
 * 30-day fake spend series) was REMOVED in D-02. Re-introducing dummy data
 * here would violate the "no seed/dummy data anywhere" rule.
 *
 * The Prisma-writing half is `prisma/seed.ts`; tests use `test/helpers.ts`
 * (freshDb) and build their OWN fixtures (spec §8: replay/fixture-own), never
 * seed data.
 */
import type { PrismaClient } from "./prisma";

export const BOOTSTRAP = {
  workspace: { id: "ws_agency", name: "Foremost Leads", plan: "internal" },
  users: [
    {
      id: "u_owner",
      workspaceId: "ws_agency",
      email: "arpit@foremostleads.in",
      name: "Arpit Sharma",
      role: "owner",
      clientAccess: "[]", // empty = all clients in the workspace
      phoneMask: false,
      twoFactor: true,
    },
    {
      id: "u_admin",
      workspaceId: "ws_agency",
      email: "admin@foremostleads.in",
      name: "Ops Admin",
      role: "admin",
      clientAccess: "[]",
      phoneMask: false,
      twoFactor: true,
    },
  ],
  // One client, named after the ad-account owner (spec §4 multi-tenant
  // invariant: 1 client ↔ 1..N ad accounts; here exactly one account today).
  client: {
    id: "cl_upcurvv",
    workspaceId: "ws_agency",
    name: "Upcurvv",
    currency: "INR",
    timezone: "Asia/Kolkata",
  },
  // The G1 LIVE ad account. Real campaigns/ads/spend rows are created by the
  // pull job (src/lib/meta/pull.ts), NOT by this file.
  adAccount: {
    metaId: "act_4749960348632164",
    clientId: "cl_upcurvv",
    name: "Upcurvv-FML",
    displayOwnerName: "Upcurvv",
    status: "ACTIVE",
    currency: "INR",
  },
} as const;

/**
 * Rows `pnpm db:seed` removes so re-running is safe WITHOUT touching real
 * data:
 *   - ad trees that are not the G1 account (leftover fixtures);
 *   - clients that are not cl_upcurvv (dev fixtures) + their data rows.
 * Real lead-side rows under cl_upcurvv (created by live G3/G4 traffic) are
 * NEVER deleted here.
 */
export function purgeRules() {
  const keepAccount = BOOTSTRAP.adAccount.metaId;
  const keepClient = BOOTSTRAP.client.id;
  return { keepAccount, keepClient };
}

/**
 * Idempotent bootstrap (fresh or existing DB). Safe to run against dev.db
 * after G3/G4 live traffic: it only deletes non-keep rows.
 */
export async function bootstrapInto(prisma: PrismaClient): Promise<void> {
  const { keepAccount, keepClient } = purgeRules();

  // 1) Leftover fixture ad trees (anything that is not the G1 account).
  for (const a of await prisma.adAccount.findMany({
    where: { metaId: { not: keepAccount } },
    select: { id: true },
  })) {
    const ads = (await prisma.ad.findMany({ where: { adAccountId: a.id }, select: { metaId: true } })).map((x) => x.metaId);
    await prisma.$transaction([
      prisma.creative.deleteMany({ where: { adMetaId: { in: ads } } }),
      prisma.spend.deleteMany({ where: { adAccountId: a.id } }),
      prisma.ad.deleteMany({ where: { adAccountId: a.id } }),
      prisma.adSet.deleteMany({ where: { adAccountId: a.id } }),
      prisma.adCampaign.deleteMany({ where: { adAccountId: a.id } }),
      prisma.adAccount.delete({ where: { id: a.id } }),
    ]);
  }

  // 2) Upsert the tenancy bootstrap (workspace, staff users, cl_upcurvv, and
  //    the G1 ad-account link row). Idempotent — safe on a fresh or live DB.
  await prisma.workspace.upsert({
    where: { id: BOOTSTRAP.workspace.id },
    update: {},
    create: { ...BOOTSTRAP.workspace },
  });
  for (const u of BOOTSTRAP.users) {
    // `update` resets clientAccess too: a pre-purge dev.db carried
    // ["cl_fitness","cl_iitprep"], which no longer exists — an empty list
    // means "all clients in the workspace" (now exactly cl_upcurvv).
    await prisma.user.upsert({
      where: { id: u.id },
      update: { clientAccess: u.clientAccess, role: u.role, phoneMask: u.phoneMask },
      create: { ...u },
    });
  }
  await prisma.client.upsert({
    where: { id: keepClient },
    update: {},
    create: { ...BOOTSTRAP.client },
  });
  const keepAcct = await prisma.adAccount.upsert({
    where: { metaId: keepAccount },
    update: {
      clientId: BOOTSTRAP.adAccount.clientId,
      name: BOOTSTRAP.adAccount.name,
      displayOwnerName: BOOTSTRAP.adAccount.displayOwnerName,
      currency: BOOTSTRAP.adAccount.currency,
    },
    create: { ...BOOTSTRAP.adAccount },
  });

  // 3) Re-parent the G1-pulled REAL ad tree to the live client. On dev.db the
  //    account link existed but its child rows still carried the old seed
  //    client id (cl_fitness) from the G1 pull; D-01 makes the ad account the
  //    organizing entity, so campaigns/ad sets/ads/spend follow the account.
  //    No-op on a fresh DB (no rows yet) and safe after re-runs.
  await prisma.adCampaign.updateMany({ where: { adAccountId: keepAcct.id }, data: { clientId: keepClient } });
  await prisma.adSet.updateMany({ where: { adAccountId: keepAcct.id }, data: { clientId: keepClient } });
  await prisma.ad.updateMany({ where: { adAccountId: keepAcct.id }, data: { clientId: keepClient } });
  await prisma.spend.updateMany({ where: { adAccountId: keepAcct.id }, data: { clientId: keepClient } });

  // 4) Fixture clients + all their data rows (children first). cl_upcurvv is
  //    kept — its lead-side rows are live G3/G4 data, never purged here.
  const dead = await prisma.client.findMany({ where: { id: { not: keepClient } }, select: { id: true } });
  if (dead.length) {
    const cid = dead.map((c) => c.id);
    await prisma.$transaction([
      prisma.formFieldMapping.deleteMany({ where: { metaLeadForm: { clientId: { in: cid } } } }),
      prisma.metaLeadForm.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.auditLog.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.outboundEvent.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.webhookLog.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.call.deleteMany({ where: { lead: { clientId: { in: cid } } } }),
      prisma.note.deleteMany({ where: { lead: { clientId: { in: cid } } } }),
      prisma.task.deleteMany({ where: { lead: { clientId: { in: cid } } } }),
      prisma.payment.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.event.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.touchpoint.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.lead.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.visitor.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.attributionRule.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.reportConfig.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.funnel.deleteMany({ where: { clientId: { in: cid } } }),
      prisma.client.deleteMany({ where: { id: { in: cid } } }),
    ]);
  }

  // 5) Non-bootstrap users, then their now-orphaned workspaces (users carry
  //    the FK, so children go first). Demo personas removed in D-02; the
  //    acting owner/admin see cl_upcurvv via an empty clientAccess list.
  await prisma.user.deleteMany({ where: { id: { notIn: BOOTSTRAP.users.map((u) => u.id) } } });
  await prisma.workspace.deleteMany({ where: { id: { not: BOOTSTRAP.workspace.id } } });
}
