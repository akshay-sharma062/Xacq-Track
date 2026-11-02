/**
 * Step 1 of the multi-account ticket: read identity for every account in
 * META_AD_ACCOUNT_IDS straight from Meta (zero manual entry) and print the
 * 7-row table `metaId | name | currency | status | state`. Read-only — no DB
 * writes. A 401/403 becomes `BLOCKED: needs <permission>` with the exact
 * Meta error; the rest continue (never a silent skip).
 */
import { readFileSync } from "node:fs";
import { fetchAccountIdentity, normalizeAdAccountRef, MetaAccessError } from "../src/lib/meta/pull";

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  const refs = (env("META_AD_ACCOUNT_IDS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeAdAccountRef)
    .filter(Boolean);
  if (!token) {
    console.error("BLOCKED: META_ACCESS_TOKEN not in .env");
    process.exit(1);
  }

  console.log("metaId | name | currency | status | state");
  for (const ref of refs) {
    try {
      const idn = await fetchAccountIdentity(ref, token, apiVersion);
      console.log(`${ref} | ${idn.name} | ${idn.currency} | ${idn.status} | OK`);
    } catch (e: any) {
      if (e instanceof MetaAccessError) {
        console.log(
          `${ref} | — | — | — | BLOCKED: needs ${e.permission ?? "permission"} (Meta ${e.status}: ${e.message})`
        );
      } else {
        console.log(`${ref} | — | — | — | ERROR: ${e?.message ?? e}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
