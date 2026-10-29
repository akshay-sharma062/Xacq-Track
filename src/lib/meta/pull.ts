/**
 * Meta Marketing API pull (spec 5.7).
 *
 * Scheduled every night + every 3h during the day (src/jobs/pull-scheduler.ts,
 * run via `pnpm jobs`). Pulls campaigns, ad sets, ads, creatives, and DAILY
 * insights per ad (spend, impressions, reach, clicks, link clicks, ThruPlays).
 * Spend is stored in BOTH the ad-account currency and INR using a STORED DAILY
 * FX rate (spec 5.7) — see fx-store.ts: the rate for each pulled day is looked
 * up from the FxRate table, fetched live only on a miss, and then persisted so
 * reports never re-convert at report time (no live-rate drift).
 *
 * Design:
 *   - `pullAdAccount()` does the real HTTP against the Marketing API.
 *   - `simulatePull()` generates a deterministic fixture ad-account tree so the
 *     "Meta Ads pull status" screen + reports work in a zero-network demo.
 * Both write through `upsertPulled()` so the DB layer is identical.
 */
import { PrismaClient } from "../prisma";
import { storeSpendRow } from "../fx";
import { resolveDayRates } from "../fx-store";

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
  /** per-day stored FX rates used for the INR column (day → rate). */
  fxRates: { day: string; rate: number }[];
  /** how many of those days needed a live FX fetch (first-time days). */
  fxLiveFills: number;
  simulated?: boolean;
}

// ---------------------------------------------------------------------------
// DB write (shared by real + simulated pulls)
// ---------------------------------------------------------------------------
/**
 * Persist a pull. `fxRates` maps each pulled day to the STORED rate used for
 * that day (spec 5.7: the daily FX rate is stored, not looked up at report
 * time). A rate of 0 means that day was converted with no rate available —
 * the row is native-only and flagged for backfill.
 */
export async function upsertPulled(
  prisma: PrismaClient,
  clientId: string,
  metaAccountId: string,
  metaAccountName: string,
  currency: string,
  ads: PulledAd[],
  fxRates: Map<string, number>,
  fxLiveFills = 0,
  simulated = false
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

    // 4) Daily spend row, native + INR (spec 5.7 / fx.ts). The rate for THIS
    //    day comes from the stored daily FX rate (Map built via fx-store), so
    //    the INR column never re-converts at report time.
    const rate = fxRates.get(a.day) ?? 0;
    const row = storeSpendRow({ spend: a.spend, currency, rate });
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
    fxRates: [...fxRates.entries()].map(([day, rate]) => ({ day, rate })),
    fxLiveFills,
    simulated,
  };
}

// ---------------------------------------------------------------------------
// Real pull against the Marketing API (requires META_ACCESS_TOKEN + ad acct)
// ---------------------------------------------------------------------------

/**
 * The daily-insights metrics we store (spec 5.7). `spend` is in the ad
 * account's billing currency; the rest are counts. `metaConversions` is the
 * "Meta-reported conversions" proxy used by the Meta-vs-Track report: Meta's
 * lead + purchase conversion fields, summed per ad per day.
 */
const INSIGHT_FIELDS = "spend,impressions,reach,clicks,link_clicks,video_play_thru_play_15s,leads,purchases";

/** GET a single Graph API object, throwing on any non-2xx (so a bad token /
 *  rate limit surfaces loudly instead of silently writing zeros). */
async function apiGet(path: string, token: string, apiVersion: string, extra: string): Promise<any> {
  const url = `https://graph.facebook.com/${apiVersion}/${path}?${extra}&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Meta ${res.status} on /${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** GET + follow `paging.next` until exhausted (spec 5.7: "pull in batches"). */
async function apiGetAll(path: string, token: string, apiVersion: string, extra: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | null = `https://graph.facebook.com/${apiVersion}/${path}?${extra}&limit=50&access_token=${token}`;
  while (url) {
    const res: Response = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Meta ${res.status} on /${path}: ${body.slice(0, 200)}`);
    }
    const j: any = await res.json();
    out.push(...(j.data ?? []));
    url = j.paging?.next ?? null;
  }
  return out;
}

/**
 * Pull one ad account: campaigns → ad sets → ad creatives → DAILY insights
 * (one spend row per ad per day, spec 5.7). Spend is stored in the account's
 * billing currency AND INR via the stored daily FX rate (fx-store). A failure
 * on any account is thrown to the caller (the orchestrator isolates it).
 */
export async function pullAdAccount(
  prisma: PrismaClient,
  clientId: string,
  metaAccessToken: string,
  adAccountMetaId: string,
  apiVersion = "v23.0",
  days = 7
): Promise<PullResult> {
  const token = metaAccessToken;

  // 0) Account meta: name + billing currency (so INR conversion uses the
  //    account's real currency, not a hard-coded "USD").
  const acct = await apiGet(adAccountMetaId, token, apiVersion, "fields=name,currency");
  const currency = (acct?.currency ?? "USD").toUpperCase();
  const accountName = acct?.name ?? adAccountMetaId;

  const ads: PulledAd[] = [];

  // 1) Campaigns → 2) ad sets → 3) ad creatives → 4) per-day insights.
  const campaigns = await apiGetAll(`${adAccountMetaId}/campaigns`, token, apiVersion, "fields=id,name,status");
  for (const c of campaigns) {
    const adsets = await apiGetAll(`${c.id}/adsets`, token, apiVersion, "fields=id,name,status,creative");
    for (const s of adsets) {
      const creatives = await apiGetAll(`${s.id}/adcreatives`, token, apiVersion, "fields=id,image_url,object_story_spec");
      for (const cr of creatives) {
        // Stable ad-object id = `<adset>_<creative>` (legacy shape, spec 5.7).
        const adMetaId = `${s.id}_${cr.id}`;
        const thumb =
          cr.image_url ??
          cr.object_story_spec?.attachments?.[0]?.image?.url ??
          null;
        const creativeType = cr.object_story_spec?.attachments?.[0]?.type === "VIDEO" ? "VIDEO" : "IMAGE";

        // 4) DAILY insights for the look-back window (one row per day).
        const insights = await apiGetAll(
          "insights",
          token,
          apiVersion,
          `level=ad&ad_id=${encodeURIComponent(adMetaId)}&time_range=${recentDays(days)}&fields=${INSIGHT_FIELDS}`
        );
        for (const it of insights) {
          const day = it.date ?? today();
          ads.push({
            adId: adMetaId,
            adsetId: s.id,
            campaignId: c.id,
            name: `${c.name} / ${s.name}`,
            status: c.status ?? "ACTIVE",
            creative: { type: creativeType, thumbnailUrl: thumb, url: cr.object_story_spec?.attachments?.[0]?.link ?? null },
            day,
            spend: num(it.spend),
            impressions: num(it.impressions),
            reach: num(it.reach),
            clicks: num(it.clicks),
            linkClicks: num(it.link_clicks),
            thruPlays: num(it.video_play_thru_play_15s),
            metaConversions: num(it.leads) + num(it.purchases),
          });
        }
      }
    }
  }

  // 5) Resolve the stored daily FX rate for every pulled day (spec 5.7).
  const dayList = [...new Set(ads.map((a) => a.day))];
  const { byDay: fxRates, liveFills } = await resolveDayRates(prisma, currency, dayList);

  return upsertPulled(prisma, clientId, adAccountMetaId, accountName, currency, ads, fxRates, liveFills);
}

/**
 * Pull every configured ad account for a client. One account's failure must
 * not stop the others (spec 5.7: "alert on failures"), so each is isolated
 * and its error recorded.
 */
export async function pullAllAccounts(
  prisma: PrismaClient,
  clientId: string,
  metaAccessToken: string,
  adAccountIds: string[],
  apiVersion = "v23.0",
  days = 7
): Promise<{ results: PullResult[]; failures: { account: string; error: string }[] }> {
  const results: PullResult[] = [];
  const failures: { account: string; error: string }[] = [];
  for (const acctId of adAccountIds) {
    try {
      results.push(await pullAdAccount(prisma, clientId, metaAccessToken, acctId, apiVersion, days));
    } catch (e: any) {
      failures.push({ account: acctId, error: String(e?.message ?? e) });
    }
  }
  return { results, failures };
}

/** `META_SIMULATE=1` forces the deterministic fixture even when a token is
 *  present — the fallback the spec asks us to keep behind a flag. */
export function isSimulateMode(): boolean {
  return process.env.META_SIMULATE === "1";
}

// Ad id in Meta is `<adset_id>_<creative_id>` (legacy "ad object" style) — we
// keep that shape so the `Ad.metaId` join is stable across pulls.
function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
/** Meta `time_range` for a look-back of N days: `{YYYY-MM-DD,YYYY-MM-DD}`. */
function recentDays(days: number): string {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  return `{${from},${to}}`;
}

// ---------------------------------------------------------------------------
// Simulated pull (zero-network demo). Deterministic so reports are stable.
// Used when META_SIMULATE=1 or no token: the same shape `pullAdAccount`
// produces, spread over `seedDays` days with a day-to-day wobble so the
// spend chart + wasted-spend report show a real series.
// ---------------------------------------------------------------------------
export function simulatePull(
  adAccountMetaId: string,
  adAccountName: string,
  seedDays = 7
): PulledAd[] {
  // Three ads with different performance profiles so wasted-spend + ROAS show:
  // Ad1 high-spend + converting, Ad2 high-spend + ZERO sales (wasted),
  // Ad3 cheap + converting.
  const templates = [
    { adId: `${adAccountMetaId}_sim1`, adsetId: "sim_set_1", campaignId: "sim_cam_1", name: `${adAccountName} · Video A — cold traffic`, status: "ACTIVE", spend: 820, impressions: 92000, reach: 51000, clicks: 1900, linkClicks: 1500, thruPlays: 420, metaConversions: 6, creative: { type: "VIDEO", thumbnailUrl: "https://picsum.photos/seed/ad1/120/68", url: "https://vimeo.com/x" } },
    { adId: `${adAccountMetaId}_sim2`, adsetId: "sim_set_1", campaignId: "sim_cam_1", name: `${adAccountName} · Static B — retargeting`, status: "ACTIVE", spend: 300, impressions: 21000, reach: 9000, clicks: 640, linkClicks: 500, thruPlays: 0, metaConversions: 9, creative: { type: "IMAGE", thumbnailUrl: "https://picsum.photos/seed/ad2/120/68", url: "https://example.com/b" } },
    { adId: `${adAccountMetaId}_sim3`, adsetId: "sim_set_2", campaignId: "sim_cam_2", name: `${adAccountName} · Carousel C — buyers`, status: "ACTIVE", spend: 55, impressions: 4000, reach: 2600, clicks: 120, linkClicks: 95, thruPlays: 0, metaConversions: 14, creative: { type: "CAROUSEL", thumbnailUrl: "https://picsum.photos/seed/ad3/120/68", url: null } },
  ];

  const out: PulledAd[] = [];
  for (let d = seedDays - 1; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    for (const t of templates) {
      // Deterministic day-to-day wobble (0.8–1.2) so the series isn't flat.
      const wobble = 0.8 + 0.4 * ((d * 7 + t.adId.length) % 10) / 10;
      out.push({
        ...t,
        day,
        spend: Math.round(t.spend * wobble * 100) / 100,
        impressions: Math.round(t.impressions * wobble),
        reach: Math.round(t.reach * wobble),
        clicks: Math.round(t.clicks * wobble),
        linkClicks: Math.round(t.linkClicks * wobble),
        metaConversions: d % 7 === 0 ? t.metaConversions + 1 : t.metaConversions,
      });
    }
  }
  return out;
}
