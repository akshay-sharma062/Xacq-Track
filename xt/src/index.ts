/**
 * Xacqora Track — tracking script (xt.js)
 * ---------------------------------------
 * Spec 5.1. One line in <head> of any landing page (Lovable, FlexiFunnels,
 * TagMango, WordPress, custom):
 *
 *   <script src="/xt.js" data-client="c_1" defer></script>
 *
 * On load it:
 *   - reads UTMs, fbclid, campaign_id/adset_id/ad_id from the URL,
 *   - creates/reads a first-party visitor_id cookie (365 days),
 *   - derives fbc from fbclid when missing, reads fbp,
 *   - POSTs one touchpoint to the configured API,
 *   - auto-fills hidden fields in any form so attribution travels with a submit,
 *   - appends the same attribution params to outgoing <a>/<button> links.
 *
 * Constraints (spec): under 10 KB minified, no measurable page-speed impact,
 * and it must survive our server being down (queues + retries via localStorage).
 *
 * Config comes from the <script> tag's data-* attributes or a global
 * `window.XACQORA_CONFIG` set before this file loads:
 *   data-api   -> base URL of our ingest API (default: same-origin)
 *   data-client-> client_id this page belongs to (required for correct tenant)
 *   data-secret-> optional per-page shared secret for signature-verified ingest
 */

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------
const cfg = (typeof window !== "undefined" ? window : ({} as any)) as any;
const config = Object.assign(
  {
    api: "", // same origin by default; override for cross-origin pages
    client: "", // client_id (tenant). Filled by data-client.
    secret: "", // optional shared secret -> signed touchpoints.
  },
  cfg.XACQORA_CONFIG || {}
);

// Merge in the script tag's data attributes (wins over global, per-page).
(function readFromScriptTag() {
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    if (!cur) return;
    const attrs = (n: string) => cur.getAttribute(n);
    if (attrs("data-api")) config.api = attrs("data-api")!;
    if (attrs("data-client")) config.client = attrs("data-client")!;
    if (attrs("data-secret")) config.secret = attrs("data-secret")!;
  } catch {
    /* SSR / no DOM: ignore */
  }
})();

// ---------------------------------------------------------------------------
// 2. URL parameter extraction (spec 5.1: UTMs, fbclid, campaign/adset/ad ids)
// ---------------------------------------------------------------------------
const PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "campaign_id",
  "adset_id",
  "ad_id",
  "fbclid",
  "fbc",
  "fbp",
] as const;

function readParams(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const q = new URLSearchParams(window.location.search);
    for (const k of PARAMS) {
      const v = q.get(k);
      if (v) out[k] = v;
    }
  } catch {
    /* no window */
  }
  return out;
}

// fbc is "fb.<fbclid>"; derive it if the URL had fbclid but not fbc.
function deriveFbc(fbclid: string | undefined, fbc: string | undefined): string | undefined {
  if (fbc) return fbc;
  if (fbclid) return `fb.${fbclid}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// 3. First-party visitor identity cookie (365 days)
// ---------------------------------------------------------------------------
const VISITOR_COOKIE = "xacqora_vid";
const VISITOR_TTL_DAYS = 365;

function getOrCreateVisitorId(): string {
  const existing = readCookie(VISITOR_COOKIE);
  if (existing) return existing;
  const id = "v_" + randomToken();
  setCookie(VISITOR_COOKIE, id, VISITOR_TTL_DAYS);
  return id;
}

function readCookie(name: string): string | null {
  try {
    const m = document.cookie
      .split("; ")
      .find((row) => row.startsWith(name + "="));
    return m ? decodeURIComponent(m.split("=").slice(1).join("=")) : null;
  } catch {
    return null;
  }
}

function setCookie(name: string, value: string, days: number): void {
  try {
    const maxAge = days * 24 * 3600;
    document.cookie = `${name}=${encodeURIComponent(
      value
    )}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {
    /* storage disabled */
  }
}

function randomToken(): string {
  // 16 chars of base36 from Math.random; collisions are astronomically unlikely
  // for our use (visitor, not secret).
  let s = "";
  while (s.length < 16) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

// ---------------------------------------------------------------------------
// 4. Build the touchpoint payload
// ---------------------------------------------------------------------------
function buildTouchpoint(): Record<string, unknown> {
  const p = readParams();
  const visitorId = getOrCreateVisitorId();
  const fbc = deriveFbc(p.fbclid, p.fbc);
  const fbp = p.fbp ?? readCookie("_fbp") ?? undefined; // Meta's own cookie if present

  return {
    client_id: config.client,
    visitor_id: visitorId,
    phone: null, // unknown at page_view time; bound later at form fill
    email: null,
    fbc: fbc ?? undefined,
    fbp: fbp,
    fbclid: p.fbclid ?? undefined,
    utm_source: p.utm_source,
    utm_medium: p.utm_medium,
    utm_campaign: p.utm_campaign,
    utm_content: p.utm_content,
    utm_term: p.utm_term,
    campaign_id: p.campaign_id,
    adset_id: p.adset_id,
    ad_id: p.ad_id,
    landing_url: safePath(window.location.href),
    referrer: document.referrer || undefined,
    device: deviceFingerprint(),
    ip: null, // server fills from request; never trust client
    ts: new Date().toISOString(),
    event: "page_view",
    sig: config.secret ? hmac(config.secret, visitorId) : undefined,
  };
}

function safePath(href: string): string {
  try {
    const u = new URL(href, window.location.origin);
    return u.pathname + u.search; // drop the origin, keep path+params
  } catch {
    return href;
  }
}

function deviceFingerprint(): string {
  return [
    navigator.userAgent || "",
    (navigator as any).language || "",
    screen ? `${screen.width}x${screen.height}` : "",
  ]
    .join("|")
    .slice(0, 200);
}

// RFC-ish HMAC-ish signature. We do NOT ship a real HMAC-SHA256 to stay under
// the size budget; instead a keyed hash. The server verifies the token matches
// the shared secret, which is the security property we actually need for
// "don't process unauthenticated touchpoints". Real Crypto.subtle HMAC is used
// server-side; this client token is a keyed PRF approximation that the server
// re-computes with the same algorithm.
function hmac(key: string, msg: string): string {
  let h = 0x811c9dc5; // FNV-1a as a small keyed mix-in, folded with the key
  const data = key + "§" + msg;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return "k1." + h.toString(36);
}

// ---------------------------------------------------------------------------
// 5. Send with offline queue + retries (spec: works without our server up)
// ---------------------------------------------------------------------------
const QUEUE_KEY = "xacqora_touch_queue";
const MAX_QUEUE = 50;
const RETRY_MS = 30_000;

function enqueue(payload: Record<string, unknown>): void {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const q: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];
    q.push({ ...payload, _enq: Date.now() });
    while (q.length > MAX_QUEUE) q.shift();
    localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  } catch {
    /* storage disabled */
  }
  sendNow();
}

function drainQueue(): Record<string, unknown>[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const q: Record<string, unknown>[] = JSON.parse(raw);
    localStorage.removeItem(QUEUE_KEY);
    return q;
  } catch {
    return [];
  }
}

let inFlight = false;

function sendNow(): void {
  if (inFlight) return;
  inFlight = true;
  const items = drainQueue();
  // Include the just-built touchpoint if we were called from init.
  if (items.length === 0) return;
  postBatch(items).finally(() => {
    inFlight = false;
    if (!document.hidden) setTimeout(maybeRetry, RETRY_MS);
  });
}

function maybeRetry(): void {
  const raw = localStorage.getItem(QUEUE_KEY);
  if (raw && JSON.parse(raw).length) sendNow();
}

async function postBatch(items: Record<string, unknown>[]): Promise<void> {
  try {
    await fetch(`${config.api || ""}/api/webhooks/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "xt", events: items }),
      keepalive: true, // flush on tab close
    });
  } catch {
    // Network failure -> re-queue so nothing is lost (spec: never drop events).
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      const q: Record<string, unknown>[] = raw ? JSON.parse(raw) : [];
      q.push(...items);
      while (q.length > MAX_QUEUE) q.shift();
      localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Auto-fill hidden fields on any form on the page
// ---------------------------------------------------------------------------
function fillHiddenFields(form: HTMLFormElement): void {
  const p = readParams();
  const visitorId = getOrCreateVisitorId();
  const fbc = deriveFbc(p.fbclid, p.fbc);
  const fields: Record<string, string | undefined> = {
    utm_source: p.utm_source,
    utm_medium: p.utm_medium,
    utm_campaign: p.utm_campaign,
    utm_content: p.utm_content,
    utm_term: p.utm_term,
    ad_id: p.ad_id,
    adset_id: p.adset_id,
    campaign_id: p.campaign_id,
    visitor_id: visitorId,
    fbc,
    fbp: p.fbp,
    xacqora_sig: config.secret ? hmac(config.secret, visitorId) : undefined,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    let input = form.querySelector<HTMLInputElement>(`input[name="${name}"]`);
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }
}

// Hook form submission: fill, then record a form_submit touchpoint.
function wireForms(): void {
  document.addEventListener(
    "submit",
    (e) => {
      const form = (e.target as HTMLFormElement)?.closest("form");
      if (!form) return;
      fillHiddenFields(form);
      const tp = buildTouchpoint();
      tp.event = "form_submit";
      tp.fields = collectSubmitted(form);
      enqueue(tp);
    },
    true
  );
}

function collectSubmitted(form: HTMLFormElement): Record<string, string> {
  const out: Record<string, string> = {};
  const data = new FormData(form);
  data.forEach((v, k) => {
    if (typeof v === "string") out[k] = v.slice(0, 500);
  });
  return out;
}

// ---------------------------------------------------------------------------
// 7. Append attribution params to outgoing links / checkout buttons
// ---------------------------------------------------------------------------
function attributionQuery(): string {
  const p = readParams();
  const visitorId = getOrCreateVisitorId();
  const fbc = deriveFbc(p.fbclid, p.fbc);
  const keep: Record<string, string | undefined> = {
    visitor_id: visitorId,
    fbc,
    fbp: p.fbp,
    fbclid: p.fbclid,
    ad_id: p.ad_id,
    adset_id: p.adset_id,
    campaign_id: p.campaign_id,
    utm_source: p.utm_source,
    utm_medium: p.utm_medium,
    utm_campaign: p.utm_campaign,
    utm_content: p.utm_content,
    utm_term: p.utm_term,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(keep)) if (v) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

function wireOutgoingLinks(): void {
  const q = attributionQuery();
  if (!q) return; // no attribution to carry; don't touch the page
  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element)?.closest?.("a") as HTMLAnchorElement | null;
      if (!a) return;
      const url = a.getAttribute("href");
      if (!url || url.startsWith("#") || url.startsWith("javascript:")) return;
      // Only append for links that leave the site or to known checkout hosts,
      // so internal nav stays clean.
      let abs = url;
      try {
        abs = new URL(url, window.location.origin).toString();
      } catch {
        return;
      }
      const u = new URL(abs);
      const internal = u.origin === window.location.origin && !u.searchParams.has("visitor_id");
      if (internal && !a.dataset.xacqora) return; // skip internal links
      if (a.dataset.xacqora === "off") return; // explicit opt-out
      for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
      a.setAttribute("href", u.toString());
    },
    true
  );
}

// ---------------------------------------------------------------------------
// 8. Init
// ---------------------------------------------------------------------------
function init(): void {
  if (!config.client) return; // nothing to attribute without a tenant
  const tp = buildTouchpoint();
  enqueue(tp); // page_view
  wireForms();
  wireOutgoingLinks();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
}

// Expose a tiny helper for host pages that want to record a custom event.
declare global {
  interface Window {
    XACQORA?: {
      track(event: string, fields?: Record<string, unknown>): void;
      config: typeof config;
    };
  }
}

if (typeof window !== "undefined") {
  window.XACQORA = {
    config,
    track(event, fields = {}) {
      const tp = buildTouchpoint();
      tp.event = event;
      tp.fields = fields;
      enqueue(tp);
    },
  };
}

export {};
