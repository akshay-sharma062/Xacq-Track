/**
 * D-09 read-only balance check for ALL ad accounts (no DB writes).
 *
 * For each `act_<id>` in the stored AdAccount rows (or META_AD_ACCOUNT_IDS),
 * GET `fields=balance,name,currency` against the live Marketing API and print
 * the EXACT outcome: 200 + the balance value, or the Meta error string
 * (401/403/etc.) — so a per-account "balance not populated" is never a silent
 * no-op: it's either BLOCKED-with-exact-error or a token-permission issue.
 * The token is read from .env in-process and NEVER printed.
 */
import { readFileSync } from "node:fs";

function env(key: string): string {
  try {
    const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
    if (!line) return "";
    return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
  } catch {
    return "";
  }
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  if (!token) {
    console.log("BLOCKED: no META_ACCESS_TOKEN in .env (read-only balance check cannot run).");
    process.exitCode = 1;
    return;
  }
  const refs = (env("META_AD_ACCOUNT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("act_") ? s : `act_${s.replace(/\D/g, "")}`));
  const out: string[] = [];
  const log = (s: string) => {
    out.push(s);
    console.log(s);
  };
  log(`BALANCE CHECK — ${new Date().toISOString()} (read-only, ${refs.length} accounts, apiVersion=${apiVersion})`);
  for (const ref of refs) {
    try {
      const res = await fetch(`https://graph.facebook.com/${apiVersion}/${ref}?fields=balance,name,currency&access_token=${token}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = (() => {
          try {
            const j = JSON.parse(body);
            return `HTTP ${res.status} ${j?.error?.message ?? ""}`.slice(0, 200);
          } catch {
            return `HTTP ${res.status} ${body.slice(0, 200)}`;
          }
        })();
        log(`${ref}: BLOCKED — ${err}`);
        continue;
      }
      const j: any = await res.json();
      log(`${ref}: 200 — balance=${j.balance ?? "(absent)"} currency=${j.currency ?? "?"} name=${j.name ?? "?"}`);
    } catch (e: any) {
      log(`${ref}: BLOCKED — FETCH_ERROR ${String(e?.message ?? e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

void main();
