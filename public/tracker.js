"use strict";
/**
 * D-17 — Xacqora visitor tracker (a first-party tracking script, built like
 * xt.js but for a DIFFERENT module with DIFFERENT fields). Paste the
 * generated install snippet into a landing page (e.g. FlexiFunnels custom-JS
 * settings) and it captures:
 *   - one page-visit per load: UTM params, device/OS/browser, screen,
 *     referrer — visitor cookie + per-session token;
 *   - LEAD events (MVP parity): thank-you pages (path detection) + form
 *     submissions (DOM submit / FlexiFunnels button click / jQuery
 *     ajaxSuccess) → a "lead" beacon once per session, with the capture
 *     source recorded (leadSource).
 * It POSTs to {data-api}/api/tracker/ingest.
 *
 * Security / privacy (spec §10):
 *   - NO secret, NO token, NO service-role key in this file or the snippet —
 *     only a PUBLIC projectId + a public base URL. A bad actor can only flood,
 *     which the per-project rate limit bounds.
 *   - NO IP: the browser script does NOT send the visitor's IP (spec rule:
 *     never obtain IPs client-side). The SERVER captures the real IP from
 *     its own request headers (cf-connecting-ip first). The body below has no
 *     `ip` field on purpose.
 *   - NO invasive fingerprinting: only the fields the spec lists. No canvas /
 *     audio / WebGL fingerprint.
 *   - Offline-safe: every POST is wrapped in .catch(() => {}) — a network
 *     failure never breaks the landing page.
 *
 * D-17.1 (MVP parity): keys are PROJECT-SCOPED (trk_vid_<projectId> etc.) —
 * a landing page can host snippets for several projects without the ids
 * clobbering each other; a "lead" is sent AT MOST ONCE per session per
 * project (sessionStorage flag), and a thank-you page refresh sends a
 * pageview instead (the MVP's exact behaviour — counts the page view, never
 * double-counts the lead).
 */
(function () {
  if (typeof document === "undefined" || typeof window === "undefined") return;

  // Config from data-* attrs on the <script> tag.
  var el = document.currentScript || null;
  var cfg = { projectId: "", api: "", eventType: "" };
  if (el) {
    var p = el.getAttribute("data-project") || el.getAttribute("data-project-id");
    if (p) cfg.projectId = p;
    var a = el.getAttribute("data-api");
    if (a) cfg.api = a.replace(/\/+$/, "");
    // data-event-type="lead" forces thank-you/lead mode for this page.
    var et = el.getAttribute("data-event-type");
    if (et) cfg.eventType = et;
  }
  if (!cfg.projectId) return; // nothing to scope to — leave the page alone

  // --- small helpers -------------------------------------------------------
  function hex(n) {
    var s = "";
    for (var i = 0; i < n; i++) s = s + Math.floor(Math.random() * 16).toString(16);
    return s;
  }

  // Project-scoped keys (a page can host snippets for several projects).
  function key(name) {
    return name + "_" + cfg.projectId;
  }

  // A first-party cookie the script can read AND write (HttpOnly=false),
  // 365-day expiry, SameSite=Lax. The value is a random 16-char hex string
  // (NOT the IP). Secure in prod is set by the browser for an https page.
  function setCookie(name, val, days) {
    try {
      var exp = new Date(Date.now() + days * 86400000).toUTCString();
      document.cookie =
        name + "=" + val + "; path=/; max-age=" + days * 86400 +
        "; expires=" + exp + "; SameSite=Lax";
    } catch (e) {}
  }
  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp("(?:^|; )\\" + name + "=([^;]*)"));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }
  function visitorId() {
    var v = readCookie(key("trk_vid"));
    if (v) return v;
    v = "v_" + hex(16);
    setCookie(key("trk_vid"), v, 365);
    return v;
  }

  // A fresh session token per browser session, kept in sessionStorage.
  function sessionToken() {
    try {
      var t = sessionStorage.getItem(key("trk_ses"));
      if (t) return t;
      t = "s_" + hex(8);
      sessionStorage.setItem(key("trk_ses"), t);
      return t;
    } catch (e) {
      return "s_" + hex(8);
    }
  }

  // Duplicate-send guard: one pageview POST per page load.
  function alreadySent() {
    try {
      return sessionStorage.getItem(key("trk_sent")) === "1";
    } catch (e) {
      return false;
    }
  }
  function markSent() {
    try {
      sessionStorage.setItem(key("trk_sent"), "1");
    } catch (e) {}
  }

  // Lead-once-per-session flag (MVP parity): a thank-you reload sends a
  // pageview, not a second lead.
  function leadSent() {
    try {
      return sessionStorage.getItem(key("trk_lead")) === "1";
    } catch (e) {
      return false;
    }
  }
  function markLeadSent() {
    try {
      sessionStorage.setItem(key("trk_lead"), "1");
    } catch (e) {}
  }

  // --- field collection ----------------------------------------------------
  function utms() {
    var out = {};
    try {
      var q = new URLSearchParams(window.location.search);
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(function (k) {
        var v = q.get(k);
        if (v) out[k] = v;
      });
    } catch (e) {}
    return out;
  }

  function parseUA(ua) {
    var d = { deviceType: "desktop", osName: "", osVersion: "", browserName: "", browserVer: "" };
    if (!ua) return d;
    var m;
    var mobile = /android|webos|iphone|ipod|blackberry|iemobile|opera mini|mobile/i.test(ua);
    var tablet = /ipad|tablet|playbook/i.test(ua);
    d.deviceType = tablet ? "tablet" : mobile ? "mobile" : "desktop";
    if ((m = ua.match(/Windows NT ([0-9.]+)/))) { d.osName = "Windows"; d.osVersion = m[1]; }
    else if ((m = ua.match(/Mac OS X ([0-9_.]+)/))) { d.osName = "macOS"; d.osVersion = m[1].replace(/_/g, "."); }
    else if ((m = ua.match(/Android ([0-9.]+)/))) { d.osName = "Android"; d.osVersion = m[1]; }
    else if ((m = ua.match(/(?:CPU OS|like Mac OS X) ([0-9_.]+)/))) { d.osName = "iOS"; d.osVersion = m[1].replace(/_/g, "."); }
    else if (/Linux/i.test(ua)) { d.osName = "Linux"; }
    if ((m = ua.match(/Edg\/([0-9.]+)/))) { d.browserName = "Edge"; d.browserVer = m[1]; }
    else if ((m = ua.match(/Firefox\/([0-9.]+)/))) { d.browserName = "Firefox"; d.browserVer = m[1]; }
    else if ((m = ua.match(/Chrome\/([0-9.]+)/))) { d.browserName = "Chrome"; d.browserVer = m[1]; }
    else if ((m = ua.match(/Safari\/([0-9.]+)/))) { d.browserName = "Safari"; d.browserVer = m[1]; }
    return d;
  }

  function buildPayload(eventType, extra) {
    var u = parseUA(navigator.userAgent || "");
    var s = utms();
    var w = window.screen ? window.screen.width : null;
    var h = window.screen ? window.screen.height : null;
    var payload = {
      projectId: cfg.projectId,
      visitorId: visitorId(),
      sessionToken: sessionToken(),
      eventType: eventType || "pageview",
      referrer: document.referrer || null,
      utmSource: s.utm_source || null,
      utmMedium: s.utm_medium || null,
      utmCampaign: s.utm_campaign || null,
      utmTerm: s.utm_term || null,
      utmContent: s.utm_content || null,
      deviceType: u.deviceType,
      osName: u.osName || null,
      osVersion: u.osVersion || null,
      browserName: u.browserName || null,
      browserVer: u.browserVer || null,
      screenW: w || null,
      screenH: h || null,
      pageUrl: window.location.href,
      // NO ip field — the server captures the real IP itself.
      timestamp: new Date().toISOString()
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
      }
    }
    return payload;
  }

  function send(payload) {
    // Cross-origin POST (the page ≠ this app), so the browser fires an
    // OPTIONS preflight first — /api/tracker/ingest handles it (CORS).
    fetch(cfg.api + "/api/tracker/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function () {}); // offline-safe: never break the page
  }

  // --- lead capture (MVP parity) -------------------------------------------
  var leadDispatched = false;
  function triggerLead(source) {
    if (leadDispatched) return;
    leadDispatched = true;
    markLeadSent();
    send(buildPayload("lead", { leadSource: source || "form" }));
  }

  function isThankYouPage() {
    if (cfg.eventType === "lead") return true;
    var path = location.pathname.toLowerCase();
    return /(thank|thanks|success|confirmed|confirmation)/.test(path);
  }

  // Hook standard DOM submits (the landing page's own forms).
  document.addEventListener("submit", function () {
    triggerLead("submit");
  }, true);

  // Hook FlexiFunnels submit buttons (the .flexi-submit-btn class + any
  // submit-type button/inputs + [data-form-submit] markers).
  document.addEventListener("click", function (e) {
    try {
      var target = e.target;
      if (!target || !target.closest) return;
      var btn = target.closest("button[type='submit'], input[type='submit'], .flexi-submit-btn, [data-form-submit]");
      if (btn) triggerLead("click");
    } catch (e) {}
  }, true);

  // Hook jQuery ajaxSuccess for FlexiFunnels ft-control.js (the contact
  // submission XHR) — the exact URL markers the MVP uses.
  if (typeof window.jQuery !== "undefined") {
    try {
      window.jQuery(document).ajaxSuccess(function (evt, xhr, settings) {
        if (settings && settings.url &&
          (settings.url.indexOf("contact_submission") !== -1 ||
           settings.url.indexOf("lead") !== -1 ||
           settings.url.indexOf("form") !== -1 ||
           settings.url.indexOf("admin-ajax") !== -1)) {
          triggerLead("ajaxSuccess");
        }
      });
    } catch (e) {}
  }

  function boot() {
    if (isThankYouPage()) {
      // A thank-you/confirmation page: the FIRST visit of the session is the
      // lead capture; a REFRESH sends a pageview instead (count the page
      // view, never double-count the lead — the MVP's behaviour).
      if (!leadSent()) {
        leadDispatched = true;
        markLeadSent();
        send(buildPayload("lead", { leadSource: "thankyou" }));
      } else {
        send(buildPayload("pageview"));
      }
    } else {
      // Standard landing page: one pageview capture per load (the form
      // interception hooks above fire the lead on a real submit).
      if (alreadySent()) return;
      markSent();
      send(buildPayload("pageview"));
    }
  }

  // --- global helper for manual invocation ---------------------------------
  window.VisitorTracker = {
    trackLead: function (extra) {
      if (extra) {
        try {
          sessionStorage.setItem(key("trk_lead_extra"), JSON.stringify(extra));
        } catch (e) {}
      }
      triggerLead("manual");
    },
    trackPageView: function () {
      send(buildPayload("pageview"));
    },
    getVisitorId: function () { return visitorId(); },
    getSessionId: function () { return sessionToken(); }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
})();
