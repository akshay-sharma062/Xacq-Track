/**
 * D-10 re-probe — "confirm time_range's supported window limits on this
 * account before building" (ticket item 3). Read-only; ONE account first
 * (cl_upcurvv → act_4749960348632164, the G1 LIVE account); NO DB access;
 * the token is read from .env in-process and NEVER printed; every recorded
 * body is token-redacted. A 400/ignored-param is a FINDING, not a failure.
 *
 * What D-08 settled (from .meta-probe-findings.txt): time_preset /
 * date_start / date_stop / period=daily are all IGNORED on this account
 * (same 30-day rollup back, 1 row); a well-formed `time_range` JSON IS the
 * one honored range param. What D-08 did NOT settle (this probe does):
 *   - does `period=day` (the valid spelling; D-08 tested the invalid
 *     "daily") return PER-DAY rows when combined with time_range?
 *   - what time_range windows are honored vs 400 (1d / 7d / 30d / 365d /
 *     730d) — the "supported window limits" the ticket asks for;
 *   - is an empty/malformed time_range the exact 400 string (BLOCKED
 *     evidence, never faked);
 *   - ad-level (per-ad) period=day feasibility (row count) — decides where
 *     per-day rows are sourced from (account-level vs per-ad calls).
 *
 * Output: .d10-range-probe.txt (gitignored scratch) + stdout. The distilled,
 * redacted matrix is committed separately in DECISIONS D-10.
 *
 * Run: pnpm range:probe
 */
import { readFileSync, writeFileSync } from "node:fs";

const ACCOUNT = "act_4749960348632164"; // cl_upcurvv's G1 account (host-agnostic: only this account probed)
const OUT = ".d10-range-probe.txt";

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
}

/** UTC YYYY-MM-DD n days before today (0 = today). */
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

const INSIGHT_FIELDS = "date_start,date_stop,spend,impressions,reach,clicks";

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  const lines: string[] = [];
  const log = (s: string) => { lines.push(s); console.log(s); };

  if (!token) {
    log("BLOCKED: META_ACCESS_TOKEN not set in .env (read-only probe cannot run).");
    writeFileSync(OUT, lines.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  const redact = (s: string) => s.split(token).join("[REDACTED_TOKEN]");

  interface Probe {
    label: string;
    path: string; // after /<apiVersion>/
    query: string; // WITHOUT access_token
  }

  const rows = new Map<Probe, { http: number; ok: boolean; rowCount: number; first: string; last: string; err: string }>();

  async function run(p: Probe) {
    const url = `https://graph.facebook.com/${apiVersion}/${p.path}?${p.query}&limit=100&access_token=${token}`;
    let http = 0, body = "", data: any[] = [];
    try {
      const res = await fetch(url);
      http = res.status;
      body = await res.text().catch(() => "");
      if (res.ok) {
        data = (JSON.parse(body).data as any[]) ?? [];
      }
    } catch (e) {
      body = `FETCH_ERROR ${String(e)}`;
    }
    const ok = http >= 200 && http < 300;
    let key = `${http}`;
    if (ok) {
      const first = data[0] ?? {};
      const last = data[data.length - 1] ?? {};
      key = `200 rows=${data.length} [${first.date_start ?? "?"}..${first.date_stop ?? "?"}]" + (${data.length > 1 ? `last [${last.date_start}..${last.date_stop}]` : "single row"} ) spend(first)=${first.spend ?? "?"}`;
    } else {
      let err = "";
      try {
        const j = JSON.parse(body);
        err = `subcode=${j?.error?.error_subcode ?? "n/a"} ${j?.error?.message ?? ""}`;
      } catch {
        err = body.slice(0, 200);
      }
      key = `${http} ${err}`.slice(0, 260);
    }
    rows.set(p, { http, ok, rowCount: ok ? data.length : 0, first: key, last: "", err: ok ? "" : key });
    log(`[${p.label}] ${key}`);
    await new Promise((r) => setTimeout(r, 250)); // stay under the token rate limit
  }

  log(`RANGE RE-PROBE — ${new Date().toISOString()}`);
  log(`account=${ACCOUNT} apiVersion=${apiVersion} (read-only; token redacted)`);
  log("");

  // (A) time_range honored-window sweep — the "supported window limits".
  const windows: [string, number, number][] = [
    // label, sinceDaysAgo, untilDaysAgo (until is inclusive)
    ["1d (yesterday)", 1, 1],
    ["7d", 7, 1],
    ["30d", 30, 1],
    ["365d", 365, 1],
    ["730d", 730, 1],
  ];
  log("A) time_range window sweep (fields=spend, account insights):");
  for (const [label, sinceD, untilD] of windows) {
    const tr = encodeURIComponent(JSON.stringify({ since: isoDaysAgo(sinceD), until: isoDaysAgo(untilD) }));
    await run({ label: `time_range ${label}`, path: `${ACCOUNT}/insights`, query: `fields=${INSIGHT_FIELDS}&time_range=${tr}` });
  }

  // (B) does per-day granularity exist on this API/account? (D-08 tested the
  //     INVALID "period=daily"; Meta's standard is period=day.)
  log("");
  log("B) period=day + time_range (the valid per-day spelling):");
  for (const [label, sinceD, untilD] of [
    ["period=day + 7d range", 7, 1] as [string, number, number],
    ["period=day + 30d range", 30, 1] as [string, number, number],
    ["period=days + 7d range", 7, 1] as [string, number, number],
  ]) {
    const tr = encodeURIComponent(JSON.stringify({ since: isoDaysAgo(sinceD), until: isoDaysAgo(untilD) }));
    const pval = label.startsWith("period=days") ? "days" : "day";
    await run({ label, path: `${ACCOUNT}/insights`, query: `fields=${INSIGHT_FIELDS}&period=${pval}&time_range=${tr}` });
  }

  // (C) BLOCKED evidence: the exact 4xx strings we'll surface, never faked.
  log("");
  log("C) malformed/empty time_range (the BLOCKED strings):");
  await run({ label: "time_range empty object", path: `${ACCOUNT}/insights`, query: `fields=${INSIGHT_FIELDS}&time_range=${encodeURIComponent("{}")}` });
  await run({ label: "time_range since>until", path: `${ACCOUNT}/insights`, query: `fields=${INSIGHT_FIELDS}&time_range=${encodeURIComponent(JSON.stringify({ since: isoDaysAgo(1), until: isoDaysAgo(7) }))}` });

  // (D) ad-level feasibility: one real ad, period=day + 7d (row count only).
  log("");
  log("D) ad-level period=day feasibility (1 ad, 7d) — decides per-ad call cost:");
  const adRes = await fetch(`https://graph.facebook.com/${apiVersion}/${ACCOUNT}/ads?fields=id&limit=1&access_token=${token}`);
  let sampleAd = "";
  if (adRes.ok) sampleAd = ((await adRes.json()).data as any[] | undefined)?.[0]?.id ?? "";
  if (!sampleAd) {
    log("D) BLOCKED: no ad id returned — ad-level feasibility not probed (not faked).");
  } else {
    log(`D) sample ad = ${sampleAd}`);
    const tr = encodeURIComponent(JSON.stringify({ since: isoDaysAgo(7), until: isoDaysAgo(1) }));
    await run({ label: "ad insights period=day + 7d", path: `${sampleAd}/insights`, query: `fields=${INSIGHT_FIELDS}&period=day&time_range=${tr}` });
  }

  // summary table (distilled for DECISIONS D-10; the full body is above)
  log("");
  log("=== DISTILLED MATRIX (committed, redacted) ===");
  for (const [p, r] of rows) {
    log(`${r.ok ? "200" : r.http}  ${p.label.padEnd(34)} ${r.ok ? `rows=${r.rowCount} ${r.first}` : `BLOCKED: ${r.err.slice(0, 200)}`}`);
  }
  log("");
  log("INTERPRETATION (no guessing):");
  log("  - a 200 with rows>1 and per-day date_start = per-day granularity AVAILABLE for that window");
  log("  - a 200 with 1 row spanning the range = range ROLLUP honored (not per-day)");
  log("  - a 400 / ignored param = the window/param is NOT supported (recorded, not faked)");

  writeFileSync(OUT, redact(lines.join("\n") + "\n"));
  console.log(`\nfindings written to ${OUT} (gitignored scratch; distilled matrix → DECISIONS D-10).`);
  // no process.exit (Windows libuv crash after a live fetch) — drain the loop.
}

main().catch((e) => {
  console.error("range-probe crashed:", e);
  process.exitCode = 1;
});
