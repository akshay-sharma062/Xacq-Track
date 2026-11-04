/**
 * G8 — labelled end-to-end proof of the LIVE CAPI path.
 *
 * Pushes ONE Conversions API Purchase event for a pixel-bearing client
 * (`cl_upcurvv`, G1) through the REAL send primitive `postOneCapiEvent`
 * (the exact URL/headers/body `sendQueue` uses) and prints, clearly
 * labelled REPLAYED — NOT LIVE TRAFFIC:
 *   - Meta HTTP status
 *   - the returned event id (fbtrace_id + event_hub_log_view[0].event_id)
 *   - Meta's OWN Event Match Quality (verbatim; normalized 0–10)
 *
 * Guardrails honoured:
 *   - NEVER calls `sendQueue` (that would drain the 30 queued + 15 failed
 *     backlog); the OutboundEvent table is not touched at all.
 *   - token/pixel are read from .env in-process and NEVER printed.
 *   - a Meta 4xx/403 = BLOCKED with the EXACT error string (never a canned
 *     success); exit 1.
 *   - a stable wire event_id (capiWireEventId of a fixed dedupKey): re-running
 *     this script re-POSTs the SAME event_id, so Meta dedups — it can never
 *     double-count.
 *   - HONEST EMQ: with no G3-matched browser-pixel traffic yet, a synthetic
 *     event's Meta-reported EMQ is what Meta reports — the script says
 *     plainly that EMQ>=7 (the acceptance bar) is only claimable from
 *     G3-matched Purchase traffic, and never invents a number.
 *
 * Evidence is appended to .g8-evidence.txt (gitignored scratch, not committed).
 */
import { readFileSync, appendFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  buildCapiEvent,
  capiDedupKey,
  capiWireEventId,
  toMetaWireEvent,
  normalizeMetaEmq,
} from "../src/lib/capi";
import { postOneCapiEvent } from "../src/lib/meta/capi";
import { META_PIXEL_ENV_KEYS } from "../src/lib/meta/pixel-map";

const CLIENT = "cl_upcurvv"; // G1 pixel-bearing account (D-07 reconciliation)

function env(key: string): string {
  const line = readFileSync(".env", "utf8").split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  return line.slice(line.indexOf("=") + 1).replace(/^["']|["']$/g, "").trim();
}

async function main() {
  const token = env("META_ACCESS_TOKEN");
  const apiVersion = env("META_API_VERSION") || "v23.0";
  const pixelKey = META_PIXEL_ENV_KEYS[CLIENT];
  if (!pixelKey) {
    console.error(`BLOCKED: no pixel env key defined for ${CLIENT} in pixel-map.ts`);
    process.exitCode = 1; // not process.exit(1) — a hard exit after a live fetch
    return; // crashes libuv on Windows (UV_HANDLE_CLOSING); let the loop drain.
  }
  const pixel = env(pixelKey);
  const out: string[] = [];
  const log = (s: string) => { out.push(s); console.log(s); };

  log(`\nG8 CAPI REPLAY — ${new Date().toISOString()}`);
  log(`client=${CLIENT}  pixel env key=${pixelKey} (value not printed)`);
  log(`token present=${!!token} (value not printed)  apiVersion=${apiVersion}`);
  if (!token || !pixel) {
    log(`BLOCKED: ${!token ? "META_ACCESS_TOKEN" : pixelKey} missing/empty in .env — cannot prove a live send (never faked).`);
    appendFileSync(".g8-evidence.txt", out.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }

  // One synthetic HIGH-SIGNAL event (phone+email+fbc+fbp+ip+ua — the full
  // user_data set) — clearly labelled replayed, NOT live traffic. Stable
  // discriminator: re-running re-POSTs the same event_id (Meta dedups).
  const identity = {
    clientId: CLIENT,
    leadId: null,
    phone: "+919812340000",
    email: "g8replay@x.com",
    fbc: "fb.g8replay",
    fbp: "g8replay-fbp",
    clientIp: "10.0.0.1",
    userAgent: "g8-replay/1.0 (CAPI live-path proof)",
  };
  // G8 (D-07): pair a web action_source with a source URL so the event is a
  // well-formed web CAPI event. `cl_upcurvv` has no Funnel landing URL, so the
  // real send path would fall back to the non-web "system" source — but this is
  // a SYNTHETIC, clearly-labelled replay, so we pass a synthetic-but-valid
  // source URL to exercise the web path (Meta validates the URL's FORMAT, not
  // its reachability). This is not live traffic and is not a real funnel.
  const payload = buildCapiEvent({
    kind: "Purchase",
    identity,
    value: 4999,
    currency: "INR",
    eventTimeIso: new Date().toISOString(),
    pixelId: pixel,
    clientIp: identity.clientIp,
    userAgent: identity.userAgent,
    eventSourceUrl: "https://upcurvv.com/w1", // synthetic, labelled replayed — NOT a real funnel
  });
  const dedupKey = capiDedupKey("Purchase", identity, "g8replay"); // stable across runs
  const wireEvent = toMetaWireEvent(payload, capiWireEventId(dedupKey));

  // The REAL shared send primitive — the same code path sendQueue uses.
  const res = await postOneCapiEvent({ pixel, token, wireEvent, apiVersion });

  if (!res.ok) {
    log(`REPLAYED — NOT LIVE TRAFFIC:`);
    log(`  Meta HTTP: ${res.httpStatus ?? "network error"}`);
    log(`  BLOCKED (exact Meta error string): ${res.error}`);
    appendFileSync(".g8-evidence.txt", out.join("\n") + "\n");
    process.exitCode = 1; // BLOCKED is a valid evidence-captured outcome, not a crash.
    return;
  }

  const emqNorm = normalizeMetaEmq(res.emqRaw);
  log(`REPLAYED — NOT LIVE TRAFFIC:`);
  log(`  Meta HTTP: ${res.httpStatus} (200 = Conversions API accepted)`);
  log(`  fbtrace_id (Meta ack): ${res.fbtraceId ?? "(not returned by Meta)"}`);
  log(`  returned event_id (event_hub_log_view[0].event_id): ${res.metaEventId ?? "(not returned by Meta)"}`);
  log(`  our wire event_id (stable dedup): ${String(wireEvent.event_id)}`);
  log(`  Meta-reported EMQ (verbatim): ${res.emqRaw == null ? "(Meta did not report an EMQ for this event)" : String(res.emqRaw)}`);
  log(`  normalized EMQ (0–10): ${emqNorm ?? "n/a (Meta reported no usable number — not invented)"}`);
  log(`  HONESTY NOTE: synthetic replayed event, not G3-matched browser-pixel traffic. The G8 acceptance bar (EMQ>=7 on Purchase) is claimed ONLY from real G3-matched Purchase traffic reaching this path; nothing here is a substitute for it.`);

  // A read-only DB sanity line (never a write): pixel-bearing client exists.
  const prisma = new PrismaClient();
  try {
    const c = await prisma.client.findUnique({ where: { id: CLIENT }, select: { name: true } });
    log(`  client row: ${CLIENT} = ${JSON.stringify(c?.name ?? null)} (read-only)`);
  } finally {
    await prisma.$disconnect();
  }

  appendFileSync(".g8-evidence.txt", out.join("\n") + "\n");
}

main().catch((e) => {
  console.error("G8 replay ERROR:", e?.message ?? e);
  process.exitCode = 1; // let the event loop drain (no hard-exit crash on Windows).
});
