/**
 * Meta API capability probe (Phase 1 — HONEST API PROBE).
 *
 * Read-only. One account first: `cl_upcurvv` → `act_4749960348632164`
 * ("Upcurvv-FML", INR, the G1 LIVE account). No Prisma import, NO DB writes —
 * safe to run while the prod server is up. Token + apiVersion read from
 * .env in-process and NEVER printed; every recorded body is redacted.
 *
 * A 400 is a FINDING, not a failure: the goal is a plain-text capability
 * matrix (param → 200/400 + body snippet) that Phase 2 builds against, so the
 * date-range UI never extrapolates past what Meta actually returns.
 *
 * Probe groups (mirrors src/lib/meta/pull.ts call shape, apiVersion v23.0):
 *   (a) account-level GET /act_<id> fields balance,name,currency  (balance is
 *       new — G1 never pulled it)
 *   (b) account INSIGHTS time params: time_preset {yesterday,
 *       last_7d/30d, last_month, last_year}, date_start/date_stop pairs
 *       (7/30/365d), period=daily — does each 400 or return real per-day rows?
 *       (G1 already 400'd time_range; re-tested here for a complete contrast.)
 *   (c) metrics lpv + clpv, separately and combined, at AD and ACCOUNT
 *       insights level — valid field or 400?
 *
 * Output: plain-text findings table written to .meta-probe-findings.txt
 * (gitignored scratch, like .g8-evidence.txt) AND printed to stdout. The
 * distilled matrix is committed separately in DECISIONS.md (Phase 3).
 *
 * Run: pnpm meta:probe
 */
import { readFileSync, writeFileSync } from "node:fs";

// One account first (PO ticket): cl_upcurvv's G1 LIVE ad account.
const ACCOUNT = "act_4749960348632164";
const OUT = ".meta-probe-findings.txt";

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
}

/** UTC YYYY-MM-DD, n days before today (0 = today). */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
const T0 = isoDaysAgo(0); // today

interface Probe {
  group: "a" | "b" | "c";
  label: string;
  /** path segment AFTER /<apiVersion>/ — e.g. `${ACCOUNT}/insights`. */
  path: string;
  /** query WITHOUT access_token (the runner appends it). */
  query: string;
  /** the hypothesis this row records (never the answer — the answer is honest data). */
  expect: string;
}

interface Result {
  probe: Probe;
  http: number;
  ok: boolean;
  /** redacted, capped body for the detail section. */
  body: string;
  /** for 200 insights: how many rows + how many distinct days (per-day signal). */
  rowCount?: number;
  distinctDays?: number;
  /** first line of a 200 body, for the table. */
  key: string;
}

function redact(token: string, s: string): string {
  return token ? s.split(token).join("[REDACTED_TOKEN]") : s;
}

async function runProbe(p: Probe, apiVersion: string, token: string): Promise<Result> {
  const base = `https://graph.facebook.com/${apiVersion}/${p.path}?${p.query}&limit=50&access_token=${token}`;
  let http = 0;
  let body = "";
  let data: any = null;
  try {
    const res = await fetch(base, { method: "GET" });
    http = res.status;
    body = await res.text().catch(() => "");
    if (res.ok) {
      data = JSON.parse(body).data ?? null;
    }
  } catch (e) {
    body = `FETCH_ERROR ${String(e)}`;
  }
  const ok = http >= 200 && http < 300;
  let rowCount: number | undefined;
  let distinctDays: number | undefined;
  let key = "";
  if (ok && Array.isArray(data)) {
    rowCount = data.length;
    const days = new Set<string>(data.map((d: any) => d.date_start));
    distinctDays = days.size;
    const first = data[0] ?? {};
    key = `rows=${rowCount} distinctDays=${distinctDays} first[${first.date_start}..${first.date_stop}] spend=${first.spend}`;
  } else if (ok) {
    // account-level object (not an insights list)
    key = JSON.stringify(data ?? {}).slice(0, 160);
  } else {
    // 400/error: capture Meta's own subcode + the invalid-param message (the
    // finding). Cap the list-of-valid-fields that Meta sometimes inlines.
    const err = (() => {
      try {
        const j = JSON.parse(body);
        const e = j?.error ?? {};
        return `subcode=${e.error_subcode ?? "n/a"} ${e.message ?? ""}`.slice(0, 300);
      } catch {
        return body.slice(0, 300);
      }
    })();
    key = `${http} ${err}`;
  }
  return { probe: p, http, ok, body: redact(token, body).slice(0, 2000), rowCount, distinctDays, key };
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  if (!token) {
    log(`BLOCKED: META_ACCESS_TOKEN not set in .env (read-only probe cannot run).`);
    writeFileSync(OUT, lines.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  // --- (c) needs a real ad id: fetch one (read-only) before the metric probes.
  const adRes = await runProbe(
    { group: "c", label: "lookup first ad", path: `${ACCOUNT}/ads`, query: "fields=id&limit=1", expect: "get a real ad id for ad-level probes" },
    apiVersion,
    token,
  );
  const adId = adRes.ok ? adRes.body.match(/"(?:id):"(\d+)"/)?.[1] : undefined;
  // re-parse data directly (runProbe redacts/caps body; grab ad id from raw):
  const adFetch = await fetch(
    `https://graph.facebook.com/${apiVersion}/${ACCOUNT}/ads?fields=id&limit=1&access_token=${token}`,
  );
  const adId2 = adFetch.ok ? (await adFetch.json()).data?.[0]?.id : undefined;
  const probeAd = adId2 || adId || "";

  const probes: Probe[] = [
    // (a) account-level — balance is NEW (G1 never pulled it).
    { group: "a", label: "acct identity+balance", path: ACCOUNT, query: "fields=balance,name,currency,account_status", expect: "balance works (never pulled by G1)" },
    { group: "a", label: "acct balance alone", path: ACCOUNT, query: "fields=balance", expect: "isolate whether the balance FIELD 400s" },
    { group: "a", label: "acct name+currency", path: ACCOUNT, query: "fields=name,currency", expect: "known-good (G1 pulled)" },

    // (b) account INSIGHTS time params (fields=spend = known-good field).
    { group: "b", label: "insights time_preset=yesterday", path: `${ACCOUNT}/insights`, query: "fields=spend&time_preset=yesterday", expect: "per-day row for yesterday" },
    { group: "b", label: "insights time_preset=last_7d", path: `${ACCOUNT}/insights`, query: "fields=spend&time_preset=last_7d", expect: "7 per-day rows" },
    { group: "b", label: "insights time_preset=last_30d", path: `${ACCOUNT}/insights`, query: "fields=spend&time_preset=last_30d", expect: "30 per-day rows" },
    { group: "b", label: "insights time_preset=last_month", path: `${ACCOUNT}/insights`, query: "fields=spend&time_preset=last_month", expect: "calendar-month rows" },
    { group: "b", label: "insights time_preset=last_year", path: `${ACCOUNT}/insights`, query: "fields=spend&time_preset=last_year", expect: "year rows" },
    { group: "b", label: "insights date_start/date_stop 7d", path: `${ACCOUNT}/insights`, query: `fields=spend&date_start=${isoDaysAgo(6)}&date_stop=${T0}`, expect: "7d per-day rows (or 400 if param invalid)" },
    { group: "b", label: "insights date_start/date_stop 30d", path: `${ACCOUNT}/insights`, query: `fields=spend&date_start=${isoDaysAgo(29)}&date_stop=${T0}`, expect: "30d per-day rows (or 400)" },
    { group: "b", label: "insights date_start/date_stop 365d", path: `${ACCOUNT}/insights`, query: `fields=spend&date_start=${isoDaysAgo(364)}&date_stop=${T0}`, expect: "365d per-day rows (or 400)" },
    { group: "b", label: "insights period=daily + last_30d", path: `${ACCOUNT}/insights`, query: "fields=spend&period=daily&time_preset=last_30d", expect: "does period=daily exist? (likely invalid param)" },
    { group: "b", label: "insights time_range (G1-known 400)", path: `${ACCOUNT}/insights`, query: `fields=spend&time_range={"since":"${isoDaysAgo(6)}","until":"${T0}"}`, expect: "confirm G1's time_range 400" },

    // (c) metrics lpv + clpv, ad + account, separately + combined.
    ...(probeAd
      ? [
          { group: "c" as const, label: "AD insights fields=lpv", path: `${probeAd}/insights`, query: "fields=lpv", expect: "is lpv a valid ad metric?" },
          { group: "c" as const, label: "AD insights fields=clpv", path: `${probeAd}/insights`, query: "fields=clpv", expect: "is clpv a valid ad metric?" },
          { group: "c" as const, label: "AD insights fields=lpv,clpv", path: `${probeAd}/insights`, query: "fields=lpv,clpv", expect: "combined" },
          { group: "c" as const, label: "ACCT insights fields=lpv", path: `${ACCOUNT}/insights`, query: "fields=lpv", expect: "is lpv valid at account level?" },
          { group: "c" as const, label: "ACCT insights fields=clpv", path: `${ACCOUNT}/insights`, query: "fields=clpv", expect: "is clpv valid at account level?" },
          { group: "c" as const, label: "ACCT insights fields=lpv,clpv", path: `${ACCOUNT}/insights`, query: "fields=lpv,clpv", expect: "combined at account level" },
        ]
      : []),
  ];

  log(`METADATA: account=${ACCOUNT} apiVersion=${apiVersion} today=${T0} probe=READ-ONLY (no DB writes)`);
  log(`ad sample for (c): ${probeAd || "(none returned — ad-level (c) skipped, not faked)"}`);
  log("=" .repeat(88));
  log(`#  GROUP  PROBE                          HTTP   STATUS/KEY`);
  log("-".repeat(88));
  const results: Result[] = [];
  let n = 0;
  for (const p of probes) {
    const r = await runProbe(p, apiVersion, token);
    n++;
    results.push(r);
    const mark = r.ok ? "200" : `${r.http}`;
    log(
      String(n).padEnd(2) + `   ${p.group}      ${p.label.slice(0, 26).padEnd(26)}  ${mark.padEnd(4)} ${r.key.slice(0, 50)}`,
    );
    await new Promise((res) => setTimeout(res, 250)); // stay under the token rate limit
  }
  log("=" .repeat(88));
  log("DETAIL (redacted; error bodies are the finding, not a failure):");
  for (const [i, r] of results.entries()) {
    log(`\n[${i + 1}] ${r.probe.group} · ${r.probe.label}  —  ${r.probe.path}?${r.probe.query}`);
    log(`    expected: ${r.probe.expect}`);
    log(`    HTTP ${r.http} ${r.ok ? "(ok)" : "(error — see body)"}`);
    if (r.rowCount != null) log(`    rows=${r.rowCount} distinctDays=${r.distinctDays}`);
    log(`    body: ${r.body.slice(0, r.ok ? 400 : 600)}`);
  }
  log("\nDONE: capability matrix recorded. Distill the 200/400 rows into DECISIONS.md (Phase 3).");

  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`\nfindings written to ${OUT} (gitignored scratch).`);
  // No process.exit — let the loop drain (Windows libuv), exitCode left 0.
}

main().catch((e) => {
  console.error("meta-probe crashed:", e);
  process.exitCode = 1;
});
