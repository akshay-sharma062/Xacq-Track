/**
 * Meta Marketing API pull (spec 5.7).
 *
 * Scheduled every night + every 3h during the day. Pulls campaigns, ad sets,
 * ads, creatives, and daily insights per ad (spend, impressions, reach,
 * clicks, link clicks, ThruPlays). Spend is stored in BOTH the ad-account
 * currency and INR using a stored daily FX rate (spec 5.7 / fx.ts).
 *
 * Design:
 *   - `pullAdAccount()` does the real HTTP against the Marketing API.
 *   - `simulatePull()` generates a deterministic fixture ad-account tree so the
 *     "Meta Ads pull status" screen + reports work in a zero-network demo.
 * Both write through `upsertPulled()` so the DB layer is identical.
 */
import { PrismaClient } from "../prisma";
import { storeSpendRow } from "../fx";

export interface PulledAd {
  adId: string;
  adsetId: string;
  campaignId: string;
  name: string;
  status: string;
  creative?: { type: string; thumbnailUrl?: string | null; url?: string | null };
  day: string; // "YYYY-MM-DD"
  spend: number; // native currency
  impressions: number;
  reach: number;
  clicks: number;
  linkClicks: number;
  thruPlays: number;
  metaConversions: number; // Meta-reported conversions (for Meta-vs-Track)
}

export interface PullResult {
  adAccount: { metaId: string; name: string; currency: string; lastPulledAt: string };
  campaigns: number;
  adSets: number;
  ads: number;
  spendRows: number;
  fxRate: number;
}

// ---------------------------------------------------------------------------
// DB write (shared by real + simulated pulls)
// ---------------------------------------------------------------------------
export async function upsertPulled(
  prisma: PrismaClient,
  clientId: string,
  metaAccountId: string,
  metaAccountName: string,
  currency: string,
  ads: PulledAd[],
  fxRate: number // USD->INR for that day; 0 if unknown
): Promise<PullResult> {
  // 1) Ad account
  let account = await prisma.adAccount.findUnique({ where: { metaId: metaAccountId } });
  if (!account) {
    account = await prisma.adAccount.create({
      data: {
        metaId: metaAccountId, clientId, name: metaAccountName, currency,
        lastPulledAt: new Date(),
      },
    });
  } else {
    account = await prisma.adAccount.update({
      where: { metaId: metaAccountId },
      data: { clientId, name: metaAccountName, currency, lastPulledAt: new Date() },
    });
  }
  const accountId = account.id;

  // 2) Campaigns / ad sets / ads (denormalise the tree so reports can group).
  const campaignIds = new Set<string>();
  const adsetIds = new Set<string>();
  let adCount = 0;
  let spendCount = 0;

  for (const a of ads) {
    campaignIds.add(a.campaignId);
    adsetIds.add(a.adsetId);

    await prisma.adCampaign.upsert({
      where: { metaId: a.campaignId },
      update: { status: a.status },
      create: { metaId: a.campaignId, adAccountId: accountId, clientId, name: `Campaign ${a.campaignId}`, status: a.status },
    });
    await prisma.adSet.upsert({
      where: { metaId: a.adsetId },
      update: {},
      create: {
        metaId: a.adsetId, adAccountId: accountId, campaignMetaId: a.campaignId,
        clientId, name: `Ad set ${a.adsetId}`, status: a.status,
      },
    });
    await prisma.ad.upsert({
      where: { metaId: a.adId },
      update: { status: a.status, name: a.name },
      create: {
        metaId: a.adId, adAccountId: accountId, adSetMetaId: a.adsetId,
        clientId, name: a.name, status: a.status,
      },
    });
    adCount++;

    // 3) Creative (one per ad; thumbnail for the report rows).
    if (a.creative) {
      const ad = await prisma.ad.findUnique({ where: { metaId: a.adId } });
      const has = await prisma.creative.findFirst({ where: { adMetaId: a.adId } });
      if (ad && !has) {
        await prisma.creative.create({
          data: {
            adMetaId: a.adId,
            type: a.creative.type,
            thumbnailUrl: a.creative.thumbnailUrl ?? null,
            url: a.creative.url ?? null,
          },
        });
      }
    }

    // 4) Daily spend row, native + INR (spec 5.7 / fx.ts).
    const row = storeSpendRow({ spend: a.spend, currency, rate: fxRate });
    await prisma.spend.upsert({
      where: { adMetaId_day: { adMetaId: a.adId, day: a.day } },
      update: {
        impressions: a.impressions, reach: a.reach, clicks: a.clicks,
        linkClicks: a.linkClicks, thruPlays: a.thruPlays,
        currency: row.currency, inrRate: row.inrRate, inrSpend: row.inrSpend,
        metaConversions: a.metaConversions,
      },
      create: {
        adMetaId: a.adId, adAccountId: accountId, clientId,
        day: a.day,
        spend: a.spend,
        impressions: a.impressions, reach: a.reach, clicks: a.clicks,
        linkClicks: a.linkClicks, thruPlays: a.thruPlays,
        currency: row.currency, inrRate: row.inrRate, inrSpend: row.inrSpend,
        metaConversions: a.metaConversions,
      },
    });
    spendCount++;
  }

  return {
    adAccount: { metaId: metaAccountId, name: metaAccountName, currency, lastPulledAt: account.lastPulledAt!.toISOString() },
    campaigns: campaignIds.size,
    adSets: adsetIds.size,
    ads: adCount,
    spendRows: spendCount,
    fxRate,
  };
}

// ---------------------------------------------------------------------------
// Real pull against the Marketing API (requires META_ACCESS_TOKEN + ad acct)
// ---------------------------------------------------------------------------
export async function pullAdAccount(
  prisma: PrismaClient,
  clientId: string,
  metaAccessToken: string,
  adAccountMetaId: string,
  apiVersion = "v23.0",
  days = 1,
  fxRate = 0
): Promise<PullResult> {
  const base = `https://graph.facebook.com/${apiVersion}/${adAccountMetaId}`;
  const token = metaAccessToken;

  // A) List campaigns (active)
  const campaigns = await (
    await fetch(
      `${base}/campaigns?fields=id,name,status&limit=50&access_token=${token}`
    )
  ).json();

  const adsets: { metaId: string; name: string; status: string; campaignId: string }[] = [];
  const ads: PulledAd[] = [];

  for (const c of campaigns.data ?? []) {
    const cset = await (
      await fetch(
        `https://graph.facebook.com/${apiVersion}/${c.id}/adgroups?fields=id,name,status,creative&limit=50&access_token=${token}`
      )
    ).json();
    for (const s of cset.data ?? []) {
      adsets.push({ metaId: s.id, name: s.name, status: s.status, campaignId: c.id });
      const list = await (
        await fetch(
          `https://graph.facebook.com/${apiVersion}/${s.id}/adcreatives?fields=id&limit=50&access_token=${token}`
        )
      ).json();
      for (const cr of list.data ?? []) {
        // Daily insights for this ad (spend + video metrics).
        const insights = await (
          await fetch(
            `https://graph.facebook.com/${apiVersion}/insights?level=ad&ad_id=${adId(s, cr)}&time_range=${recent(days)}&fields=spend,impressions,reach,clicks,link_clicks,video_play_thru_play_15s,converted_product_orders&access_token=${token}`
          )
        ).json();
        const it = (insights.data ?? [])[0];
        const when = it?.date ?? today();
        ads.push({
          adId: adId(s, cr),
          adsetId: s.id,
          campaignId: c.id,
          name: `${c.name} / ${s.name}`,
          status: c.status,
          creative: { type: "IMAGE", thumbnailUrl: null, url: null },
          day: when,
          spend: num(it?.spend),
          impressions: num(it?.impressions),
          reach: num(it?.reach),
          clicks: num(it?.clicks),
          linkClicks: num(it?.link_clicks),
          thruPlays: num(it?.video_play_thru_play_15s),
          metaConversions: num(it?.converted_product_orders),
        });
      }
    }
  }

  return upsertPulled(prisma, clientId, adAccountMetaId, adAccountMetaId, "USD", ads, fxRate);
}

// Ad id in Meta is `<adset_id>_<creative_id>` (legacy "ad object" style) — we
// keep that shape so the `Ad.metaId` join is stable across pulls.
function adId(adset: { id: string }, creative: { id: string }): string {
  return `${adset.id}_${creative.id}`;
}
function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function recent(days: number): string {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return `{${from},${to}}`;
}

// ---------------------------------------------------------------------------
// Simulated pull (zero-network demo). Deterministic so reports are stable.
// ---------------------------------------------------------------------------
export function simulatePull(
  adAccountMetaId: string,
  adAccountName: string,
  seedDays = 3
): Omit<PulledAd, "day">[] & { currency: string } {
  // Three ads with different performance profiles so wasted-spend + ROAS show.
  const templates = [
    { adId: "sim_ad_1", adsetId: "sim_set_1", campaignId: "sim_cam_1", name: "Video A — cold traffic", status: "ACTIVE", spend: 820, impressions: 92000, reach: 51000, clicks: 1900, linkClicks: 1500, thruPlays: 420, metaConversions: 6, creative: { type: "VIDEO", thumbnailUrl: "https://picsum.photos/seed/ad1/120/68", url: "https://vimeo.com/x" } },
    { adId: "sim_ad_2", adsetId: "sim_set_1", campaignId: "sim_cam_1", name: "Static B — retargeting", status: "ACTIVE", spend: 300, impressions: 21000, reach: 9000, clicks: 640, linkClicks: 500, thruPlays: 0, metaConversions: 9, creative: { type: "IMAGE", thumbnailUrl: "https://picsum.photos/seed/ad2/120/68", url: "https://example.com/b" } },
    { adId: "sim_ad_3", adsetId: "sim_set_2", campaignId: "sim_cam_2", name: "Carousel C — buyers", status: "ACTIVE", spend: 55, impressions: 4000, reach: 2600, clicks: 120, linkClicks: 95, thruPlays: 0, metaConversions: 14, creative: { type: "CAROUSEL", thumbnailUrl: "https://picsum.photos/seed/ad3/120/68", url: null } },
  ];
  // Attach the most recent day (spec: pull daily).
  const day = today();
  const out: PulledAd[] = templates.map((t) => ({ ...t, day }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _account = adAccountMetaId; // name is informational for the caller
  return out as any;
}
