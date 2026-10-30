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
  /** human names (for the DB create paths); optional so the simulate path stays lean */
  adsetName?: string | null;
  campaignName?: string | null;
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
      update: { status: a.status, ...(a.campaignName ? { name: a.campaignName } : {}) },
      create: { metaId: a.campaignId, adAccountId: accountId, clientId, name: a.campaignName ?? `Campaign ${a.campaignId}`, status: a.status },
    });
    await prisma.adSet.upsert({
      where: { metaId: a.adsetId },
      update: { ...(a.adsetName ? { name: a.adsetName } : {}) },
      create: {
        metaId: a.adsetId, adAccountId: accountId, campaignMetaId: a.campaignId,
        clientId, name: a.adsetName ?? `Ad set ${a.adsetId}`, status: a.status,
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
 * Verified-per-ad insights fields (G1 live verification, 2026-10-29, account
 * act_…2164, API v23.0). Findings from the live probes that shaped this:
 *   - `time_range` in ANY form 400s ("must be non-empty") on this account,
 *     but the NO-range call returns Meta's default 30-day rollup
 *     [date_start, date_stop] — one row per ad. `day` is stored as date_stop.
 *   - `link_clicks`, `leads`, `purchases`, `video_plays_15_sec` are NOT
 *     valid insights fields on this API version → `clicks` proxies
 *     linkClicks and ThruPlays is stored 0 (documented proxy, not a guess).
 *   - `results` (list of Meta-reported conversion indicators) is valid and
 *     powers `metaConversions` for the Meta-vs-Track report.
 *   - `spend` is in the account's billing currency (INR here, not USD).
 */
const INSIGHT_FIELDS = "date_start,date_stop,spend,impressions,reach,clicks,results";

/**
 * Meta ad-account refs need the `act_` prefix; operators paste bare numbers.
 * Also strips stray quotes/whitespace (a real .env hygiene bug found in G1:
 * the saved value contained a literal quote char, and the raw ref 404'd).
 */
export function normalizeAdAccountRef(raw: string): string {
  const s = raw.trim().replace(/[^0-9a-z_]/gi, "");
  if (/^act_\d+$/.test(s)) return s;
  return s ? `act_${s}` : "";
}

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
 * Pull one ad account (spec 5.7): account meta → ad objects (with ad set +
 * campaign + creative) → per-ad insights rollup. Verified live 2026-10-29 on
 * act_…2164 (v23.0): the account's insights `time_range` param 400s, so we use
 * the no-range rollup (one row per ad: [date_start, date_stop]); `day` is the
 * rollup's date_stop. Spend is in the account's billing currency and is
 * converted to INR via the stored daily FX rate (fx-store). A failure is
 * thrown to the caller (the orchestrator isolates it per account).
 */
export async function pullAdAccount(
  prisma: PrismaClient,
  clientId: string,
  metaAccessToken: string,
  adAccountMetaId: string,
  apiVersion = "v23.0"
): Promise<PullResult> {
  const token = metaAccessToken;
  const ref = normalizeAdAccountRef(adAccountMetaId) || adAccountMetaId;

  // 0) Account meta: name + billing currency (INR accounts convert 1:1).
  const acct = await apiGet(ref, token, apiVersion, "fields=name,currency,account_status");
  const currency = (acct?.currency ?? "USD").toUpperCase();
  const accountName = acct?.name ?? ref;

  const ads: PulledAd[] = [];

  // 1) Ad objects with their ad set + campaign + creative (ad objects ARE the
  //    spend units in modern Meta; the legacy adset_creative id is gone).
  const adObjects = await apiGetAll(
    `${ref}/ads`,
    token,
    apiVersion,
    "fields=id,name,status,campaign{id,name},adset{id,name},creative{object_story_spec}"
  );

  for (const ad of adObjects) {
    const adset = ad.adset ?? {};
    const campaign = ad.campaign ?? {};
    const attach = ad.creative?.object_story_spec?.attachments?.[0] ?? {};
    const thumb =
      attach.image?.url ?? attach.animated_image?.url ?? attach.video?.url ?? attach.link ?? null;
    const creativeType =
      attach.type === "VIDEO" || attach.video?.url ? "VIDEO" : "IMAGE";

    // 2) Per-ad insights rollup, no time_range (verified shape, see above).
    const insights = await apiGetAll(
      `${ad.id}/insights`,
      token,
      apiVersion,
      `fields=${INSIGHT_FIELDS}&limit=100`
    );
    for (const it of insights) {
      const row: PulledAd = {
        adId: ad.id,
        adsetId: adset.id ?? adset.name ?? "unknown_set",
        campaignId: campaign.id ?? campaign.name ?? "unknown_campaign",
        adsetName: adset.name ?? null,
        campaignName: campaign.name ?? null,
        name: `${campaign.name ?? campaign.id ?? "campaign"} / ${adset.name ?? adset.id ?? "adset"} / ${ad.name ?? ad.id}`,
        status: ad.status ?? campaign.status ?? "ACTIVE",
        creative: { type: creativeType, thumbnailUrl: thumb, url: attach.link ?? null },
        day: it.date_stop ?? today(), // the rollup window's last day
        spend: num(it.spend),
        impressions: num(it.impressions),
        reach: num(it.reach),
        clicks: num(it.clicks),
        linkClicks: num(it.clicks), // link_clicks is invalid on this version; clicks is the proxy (documented)
        thruPlays: 0, // video_play fields invalid here; documented proxy
        metaConversions: resultsToConversions(it.results),
      };
      ads.push(row);
    }
    // An ad with no spend data in the window still gets a zero row so the
    // report shows it (spec 7 wasted-spend needs the ad to be visible).
    if (insights.length === 0) {
      ads.push({
        adId: ad.id,
        adsetId: adset.id ?? adset.name ?? "unknown_set",
        campaignId: campaign.id ?? campaign.name ?? "unknown_campaign",
        name: `${campaign.name ?? campaign.id ?? "campaign"} / ${adset.name ?? adset.id ?? "adset"} / ${ad.name ?? ad.id}`,
        status: ad.status ?? "ACTIVE",
        creative: { type: creativeType, thumbnailUrl: thumb, url: attach.link ?? null },
        day: today(),
        spend: 0,
        impressions: 0,
        reach: 0,
        clicks: 0,
        linkClicks: 0,
        thruPlays: 0,
        metaConversions: 0,
      });
    }
  }

  // 3) Stored daily FX rate for every pulled day (spec 5.7). INR accounts are
  //    identity — no live FX fetch happens for them.
  const dayList = [...new Set(ads.map((a) => a.day))];
  const { byDay: fxRates, liveFills } = await resolveDayRates(prisma, currency, dayList);

  return upsertPulled(prisma, clientId, ref, accountName, currency, ads, fxRates, liveFills);
}

/**
 * Meta's `results` payload is a list of {indicator, value, action_type}
 * conversion entries. Sum their values as the Meta-reported-conversions
 * proxy for the Meta-vs-Track report (spec 7). Defensive: shapes vary.
 */
export function resultsToConversions(results: unknown): number {
  if (!Array.isArray(results)) return 0;
  let total = 0;
  for (const r of results) {
    total += Number((r as any)?.value ?? 0) || 0;
  }
  return total;
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
  apiVersion = "v23.0"
): Promise<{ results: PullResult[]; failures: { account: string; error: string }[] }> {
  const results: PullResult[] = [];
  const failures: { account: string; error: string }[] = [];
  for (const acctId of adAccountIds) {
    try {
      results.push(await pullAdAccount(prisma, clientId, metaAccessToken, acctId, apiVersion));
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

// Ad objects ARE the spend units in modern Meta (adset_creative ids are gone),
// so `Ad.metaId` = the ad object id (stable across pulls, per ad).
function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
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
