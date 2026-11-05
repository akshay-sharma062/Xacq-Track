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
  /**
   * D-08 (Meta data expansion): the ad-account balance (billing amount due,
   * in the account currency) when the probe-proven `fields=balance` fetch
   * succeeded. null = not fetched (simulate) or the fetch failed — the stored
   * column stays as-is, the card shows "—" (never a fake 0).
   */
  balance?: number | null;
  /** exact Meta error string when the balance fetch 4xx'd (recorded, not blocking). */
  balanceNote?: string | null;
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
  simulated = false,
  status: string = "ACTIVE",
  /** D-08: the live balance (bill amount due, account currency) from the
   *  probe-proven `fields=balance` fetch. Written to the row ONLY when a real
   *  number came back; null/undefined (fetch failed or simulate) NEVER clears
   *  a previously stored value — the card keeps showing the last known
   *  balance, never zeroes it on a transient Meta error. */
  balance?: number | null,
  /** D-08: the exact Meta error string when the balance fetch 4xx'd (recorded, not thrown). */
  balanceNote?: string | null,
): Promise<PullResult> {
  // 1) Ad account. D-01: the link row carries displayOwnerName + Meta
  // account_status so the ad-account filter control shows the live state.
  // D-08: balance only written when balance is a real number (see param docs).
  const balanceWrite =
    balance != null ? { balance, balanceAsOf: new Date() } : {};
  let account = await prisma.adAccount.findUnique({ where: { metaId: metaAccountId } });
  if (!account) {
    account = await prisma.adAccount.create({
      data: {
        metaId: metaAccountId, clientId, name: metaAccountName, currency,
        displayOwnerName: metaAccountName, status,
        lastPulledAt: new Date(),
        ...balanceWrite,
      },
    });
  } else {
    account = await prisma.adAccount.update({
      where: { metaId: metaAccountId },
      data: {
        clientId, name: metaAccountName, currency, status, lastPulledAt: new Date(),
        ...balanceWrite,
      },
    });
  }
  const accountId = account.id;

  // 1b) SNAPSHOT REPLACE — the spend rows below are one 30-day rollup (Meta's
  //     no-range insights: one row per ad stamped day=date_stop, which advances
  //     with every pull). The (adMetaId, day) upsert key therefore does NOT
  //     dedup re-pulls: a second pull stamps a newer day and STACKS a second
  //     overlapping 30-day window, double-counting spend (found live on the
  //     multi-account re-pull: G1 ₹51,480.77 → ₹115,887.55 = two windows).
  //     So each pull replaces this account's previous snapshot. The pull only
  //     reaches this point AFTER every API call succeeded (pullAdAccount
  //     fetches all ads + insights first), so a failed re-pull can never wipe
  //     a good snapshot.
  await prisma.spend.deleteMany({ where: { adAccountId: accountId } });

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
    balance: balance ?? null,
    balanceNote: balanceNote ?? null,
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

/**
 * Thrown when a single Meta ad account is unreadable (401/403 etc.). Carries
 * the HTTP status + the Meta-reported permission so the orchestrator can mark
 * that account BLOCKED with the exact reason and continue with the others —
 * the multi-account isolation rule (G1 precedent: two seed accounts 403'd for
 * missing ads_read; we recorded it, we did not abort the batch).
 */
export class MetaAccessError extends Error {
  status: number;
  permission: string | null;
  constructor(message: string, status: number, permission: string | null) {
    super(message);
    this.name = "MetaAccessError";
    this.status = status;
    this.permission = permission;
  }
}

/**
 * D-08 (Meta data expansion): parse Meta's `balance` field (the ad-account
 * "bill amount due", returned as a string in the account currency — same
 * major-unit convention as insights `spend`). Empty / non-numeric → null,
 * never a guess.
 */
export function parseMetaBalance(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(typeof raw === "string" ? raw : raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * D-08: fetch the ad-account balance (probe (a) proved `fields=balance` 200s on
 * v23.0; G1 never pulled it). Isolated by design: a 4xx on balance must NOT
 * fail the whole spend pull (the G4 per-account isolation rule) — it returns
 * `{ balance: null, note: <exact Meta error> }` and the caller keeps the last
 * stored value (the card shows the last known balance, never a fake 0).
 */
export async function fetchAccountBalance(
  ref: string,
  token: string,
  apiVersion: string,
): Promise<{ balance: number | null; note: string | null }> {
  try {
    const j: any = await apiGet(ref, token, apiVersion, "fields=balance");
    const bal = parseMetaBalance(j?.balance);
    return bal != null
      ? { balance: bal, note: null }
      : { balance: null, note: "Meta returned no balance value (field absent/empty) — last stored value kept" };
  } catch (e: any) {
    // apiGet throws "Meta <status> on /<ref>: <body>" — the exact string, recorded.
    return { balance: null, note: String(e?.message ?? e) };
  }
}

/**
 * Read one ad account's identity straight from the API (the "zero-manual" rule:
 * name + currency + status all come from Meta, never typed in). On 401/403 it
 * throws a structured `MetaAccessError` with the permission name from Meta's
 * payload so the caller can record EXACTLY why the account is blocked.
 */
export async function fetchAccountIdentity(
  ref: string,
  token: string,
  apiVersion: string
): Promise<{ name: string; currency: string; status: string }> {
  const url = `https://graph.facebook.com/${apiVersion}/${ref}?fields=name,currency,account_status&access_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let parsed: any;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const err = parsed?.error ?? {};
    const message = err.message ?? body.slice(0, 200);
    // The permission name, if Meta tells us: error_data.error_subcode wins,
    // else the first known-permission token in the message.
    const permission: string | null =
      err.error_data?.error_subcode ??
      (message.match(/\b(ads_read|ads_management|read_insights|business_management)\b/) ?? [null])[0] ??
      null;
    throw new MetaAccessError(`Meta ${res.status} on /${ref}: ${message}`, res.status, permission);
  }
  const j: any = await res.json();
  return {
    name: j.name ?? ref,
    currency: (j.currency ?? "USD").toUpperCase(),
    status: normalizeAccountStatus(j.account_status),
  };
}

// ---------------------------------------------------------------------------
// Multi-account onboarding (PO 2026-11-02): zero-manual. The operator gives
// ad-account IDs; every row below is pulled from Meta + auto-provisioned.
// ---------------------------------------------------------------------------

/**
 * Meta's `account_status` arrives as a NUMBER in this API version
 * (1=ACTIVE, 0=DISABLED), but the `AdAccount.status` column is a String.
 * Normalize without guessing: known codes → label, unknown → raw string,
 * null → "ACTIVE" (the bootstrap default). String codes are passed through
 * (upper-cased) so future API versions that return names keep working.
 */
export function normalizeAccountStatus(raw: unknown): string {
  if (raw == null || raw === "") return "ACTIVE";
  if (typeof raw === "string") {
    return raw === "1" ? "ACTIVE" : raw === "0" ? "DISABLED" : raw.toUpperCase();
  }
  if (raw === 1) return "ACTIVE";
  if (raw === 0) return "DISABLED";
  return String(raw);
}

/** Client naming rule (D-04): one client per account, named after it. */
export function slugifyOwner(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * The workspace auto-created clients attach to. All of our clients live in the
 * agency workspace (single one post D-02); fall back to creating it.
 */
async function resolveOnboardingWorkspace(prisma: PrismaClient): Promise<string> {
  const c = await prisma.client.findFirst({ select: { workspaceId: true } });
  if (c) return c.workspaceId;
  const w = await prisma.workspace.findFirst();
  if (w) return w.id;
  const ws = await prisma.workspace.create({ data: { name: "Foremost Leads" } });
  return ws.id;
}

/**
 * D-04 auto client-naming: return the client that owns this account. If the
 * AdAccount link row already exists, REUSE its client (never re-parent — the
 * G1 rule). Otherwise create `cl_<slugified-name>` + the link row. Idempotent:
 * a re-run finds the row and keeps the mapping.
 */
export async function resolveOrCreateClientForAccount(
  prisma: PrismaClient,
  ref: string,
  name: string,
  currency: string,
  status: string,
  workspaceId?: string
): Promise<string> {
  // (1) The AdAccount link row is the source of truth. If it exists, reuse its
  //     client and NEVER re-parent (the G1 idempotency rule: cl_upcurvv must
  //     survive every re-pull).
  const existing = await prisma.adAccount.findUnique({ where: { metaId: ref }, select: { clientId: true } });
  if (existing) return existing.clientId;

  const ws = workspaceId ?? (await resolveOnboardingWorkspace(prisma));
  const slug = slugifyOwner(name) || ref.replace(/[^0-9a-z]/gi, "").slice(0, 8);
  const tail = ref.replace(/[^0-9a-z]/gi, "").slice(-6);

  // (2) Candidate client id = cl_<slug>. A clean id is reusable even when a
  //     partial prior run created it but not the link row (owner===null → the
  //     upsert below is a no-op on the client). A collision (a DIFFERENT
  //     account already owns this id) means two accounts slugify to the same
  //     name → suffix with the account-ref tail to keep the 1:1 mapping.
  let clientId = `cl_${slug}`;
  const owner = await prisma.adAccount.findFirst({ where: { clientId }, select: { metaId: true } });
  if (owner && owner.metaId !== ref) clientId = `cl_${slug}_${tail}`;

  // (3) Create the client + link row (both upserts are idempotent).
  await prisma.client.upsert({
    where: { id: clientId },
    update: {},
    create: { id: clientId, workspaceId: ws, name, currency: "INR" },
  });
  await prisma.adAccount.upsert({
    where: { metaId: ref },
    update: {},
    create: { metaId: ref, clientId, name, currency, displayOwnerName: name, status },
  });
  return clientId;
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

  // 0b) D-08: the ad-account balance (bill amount due), probe (a)-proven 200 on
  //     v23.0; G1 never pulled it. Isolated — a balance 400 records the exact
  //     error (balanceNote) but never fails the spend pull (the G4 rule).
  const bal = await fetchAccountBalance(ref, token, apiVersion);

  const ads: PulledAd[] = [];

  // 1) Ad objects with their ad set + campaign + creative (ad objects ARE the
  //    spend units in modern Meta; the legacy adset_creative id is gone).
  const adObjects = await apiGetAll(
    `${ref}/ads`,
    token,
    apiVersion,
    "fields=id,name,status,campaign{id,name},adset{id,name},creative{object_story_spec}"
  );

  // 2) Per-ad insights rollup, no time_range (verified shape, see above).
  //    Capped concurrency (3) so a large account (~1,500 ads) doesn't take
  //    hours — see mapConcurrent. Each ad yields its rows (or one zero row if
  //    it had no spend in the window, so wasted-spend still shows it).
  const perAdRows = await mapConcurrent(adObjects, async (ad: any) => {
    const adset = ad.adset ?? {};
    const campaign = ad.campaign ?? {};
    const attach = ad.creative?.object_story_spec?.attachments?.[0] ?? {};
    const thumb =
      attach.image?.url ?? attach.animated_image?.url ?? attach.video?.url ?? attach.link ?? null;
    const creativeType =
      attach.type === "VIDEO" || attach.video?.url ? "VIDEO" : "IMAGE";
    const base = {
      adId: ad.id,
      adsetId: adset.id ?? adset.name ?? "unknown_set",
      campaignId: campaign.id ?? campaign.name ?? "unknown_campaign",
      adsetName: adset.name ?? null,
      campaignName: campaign.name ?? null,
      name: `${campaign.name ?? campaign.id ?? "campaign"} / ${adset.name ?? adset.id ?? "adset"} / ${ad.name ?? ad.id}`,
      status: ad.status ?? campaign.status ?? "ACTIVE",
      creative: { type: creativeType, thumbnailUrl: thumb, url: attach.link ?? null },
    };

    const insights = await apiGetAll(
      `${ad.id}/insights`,
      token,
      apiVersion,
      `fields=${INSIGHT_FIELDS}&limit=100`
    );
    const rows: PulledAd[] = insights.map((it: any) => ({
      ...base,
      day: it.date_stop ?? today(), // the rollup window's last day
      spend: num(it.spend),
      impressions: num(it.impressions),
      reach: num(it.reach),
      clicks: num(it.clicks),
      linkClicks: num(it.clicks), // link_clicks is invalid on this version; clicks is the proxy (documented)
      thruPlays: 0, // video_play fields invalid here; documented proxy
      metaConversions: resultsToConversions(it.results),
    }));
    // An ad with no spend data in the window still gets a zero row so the
    // report shows it (spec 7 wasted-spend needs the ad to be visible).
    if (rows.length === 0) {
      rows.push({
        ...base,
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
    return rows;
  }, 3);
  // Flatten the per-ad row arrays (index-aligned by mapConcurrent) into `ads`.
  for (const rows of perAdRows) ads.push(...rows);

  // 3) Stored daily FX rate for every pulled day (spec 5.7). INR accounts are
  //    identity — no live FX fetch happens for them.
  const dayList = [...new Set(ads.map((a) => a.day))];
  const { byDay: fxRates, liveFills } = await resolveDayRates(prisma, currency, dayList);

  const result = await upsertPulled(
    prisma, clientId, ref, accountName, currency, ads, fxRates, liveFills, false,
    normalizeAccountStatus(acct?.account_status),
    // D-08: only write the balance column when the fetch succeeded (non-null).
    // A failed fetch (bal.balance===null) keeps the last stored value — never
    // zeroes the card on a transient Meta error.
    bal.balance,
    bal.note,
  );

  // simulate: a deterministic fixture — no live balance, note it as such so the
  // caller knows "—" means "not pulled", not "account owes nothing".
  if (isSimulateMode()) {
    result.balance = null;
    result.balanceNote = "simulate mode — no live balance fetch";
  }
  return result;
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
): Promise<{
  results: PullResult[];
  failures: { account: string; error: string; permission: string | null; status: number | null }[];
}> {
  const results: PullResult[] = [];
  const failures: {
    account: string;
    error: string;
    permission: string | null;
    status: number | null;
  }[] = [];
  for (const acctId of adAccountIds) {
    try {
      results.push(await pullAdAccount(prisma, clientId, metaAccessToken, acctId, apiVersion));
    } catch (e: any) {
      failures.push({
        account: acctId,
        error: String(e?.message ?? e),
        permission: e?.permission ?? null,
        status: e?.status ?? null,
      });
    }
  }
  return { results, failures };
}

export interface OnboardedAccount {
  metaId: string;
  name: string;
  currency: string;
  status: string;
  clientId: string;
  spendRows: number;
}
export interface OnboardFailure {
  metaId: string;
  status: number | null; // 401/403
  permission: string | null; // Meta's named permission, when it gave one
  error: string; // the exact message, for the BLOCKED record
}

/**
 * Multi-account onboarding orchestrator (PO 2026-11-02). For each ad-account
 * id: read identity from the API → auto-provision the tenant (client named
 * after the account + the AdAccount link row, idempotent, never clobbers an
 * existing mapping) → full entity + spend pull. One account's 401/403 is
 * isolated (recorded with the exact Meta error + permission) and the rest
 * continue. Accessible accounts are pulled through the SAME real path as G1.
 */
export async function onboardAccounts(
  prisma: PrismaClient,
  refs: string[],
  metaAccessToken: string,
  apiVersion = "v23.0"
): Promise<{ onboarded: OnboardedAccount[]; blocked: OnboardFailure[] }> {
  const onboarded: OnboardedAccount[] = [];
  const blocked: OnboardFailure[] = [];
  for (const raw of refs) {
    const ref = normalizeAdAccountRef(raw) || raw;
    try {
      // 1) Identity from the API (throws MetaAccessError on 401/403).
      const idn = await fetchAccountIdentity(ref, metaAccessToken, apiVersion);
      // 2) Auto-provision tenant (reuses any existing mapping — G1 idempotency).
      const clientId = await resolveOrCreateClientForAccount(
        prisma, ref, idn.name, idn.currency, idn.status
      );
      // 3) Full entity + spend pull (isolated per account by pullAdAccount).
      const res = await pullAdAccount(prisma, clientId, metaAccessToken, ref, apiVersion);
      onboarded.push({
        metaId: ref,
        name: idn.name,
        currency: idn.currency,
        status: idn.status,
        clientId,
        spendRows: res.spendRows,
      });
    } catch (e: any) {
      const blocked403 =
        e instanceof MetaAccessError ||
        (e?.status && (e.status === 401 || e.status === 403));
      blocked.push({
        metaId: ref,
        status: e?.status ?? null,
        permission: e?.permission ?? null,
        error: blocked403 ? String(e?.message ?? e) : String(e?.message ?? e),
      });
      // Only access (401/403) is "blocked — needs a permission". Anything else
      // (rate limit, transient 5xx, malformed response) is a real pull error:
      // the account DID read identity, so record it as a blocked-with-error
      // row the operator can re-run, not a silent success.
    }
  }
  return { onboarded, blocked };
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

/**
 * Run async work in capped-concurrency waves (spec: "pull in batches"). Meta's
 * per-token rate limit makes a serial fan-out across a large account's ~1,500
 * ads take hours; 3 concurrent GETs stays well under it. Order of results is
 * preserved (index-aligned), matching the serial `for` it replaces.
 */
export async function mapConcurrent<T, U>(
  items: T[],
  worker: (item: T) => Promise<U>,
  limit = 3
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let i = 0;
  async function lane(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  return out;
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
