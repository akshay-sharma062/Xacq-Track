// D-10 Step 1 — reproduce the RangePicker client-side exception on the PROD
// build (http://localhost:3000), BEFORE fixing. Drives a headless Chrome via
// raw CDP (Node's built-in WebSocket) so we capture the ACTUAL console
// error instead of fixing blind.
//
// Steps:
//   1. GET /                 — initial hydration (the classic boundary error
//      fires here: "useSearchParams() should be wrapped in a suspense boundary")
//   2. client-side nav: click a ?adAccount= drill-down link (in-app link →
//      Next.js router, not a full load)
//   3. client-side nav: fire the RangePicker select (router.replace → ?range=7d)
//   4. report every console.error / pageerror captured (the evidence)
//
// Output: .d10-repro.txt (gitignored scratch) + stdout.

import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9333;
const OUT = ".d10-repro.txt";

const log = (lines) => (s) => { lines.push(s); console.log(s); };

async function httpJson(url) {
  const r = await fetch(url);
  return r.json();
}

async function main() {
  const lines = [];
  const out = log(lines);

  // Launch a dedicated headless instance (never the user's Chrome).
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=D:/Xacq-Track/.debug-chrome-profile",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  let pid = chrome.pid;

  // Poll until the CDP endpoint is up (Chrome needs a moment to start).
  let targets = [];
  for (let i = 0; i < 40; i++) {
    try {
      targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      if (targets.length) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const page = targets.find((t) => t.type === "page") ?? targets[0];
  if (!page) throw new Error("no CDP page target — Chrome did not start");
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/devtools/page/${page.id}`);

  let seq = 0;
  const pending = new Map();
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      // capture the real evidence: console errors + uncaught page errors
      const p = msg.params ?? {};
      if (msg.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) {
        const text = (p.args ?? []).map((a) => a.value ?? a.description ?? (a.type === "object" ? a.preview?.description ?? "obj" : "")).join(" ");
        events.push(`console.${p.type}: ${String(text).slice(0, 400)}`);
      }
      if (msg.method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails;
        events.push(`PAGEERROR: ${d.exception?.description ?? d.text ?? "?"}`.slice(0, 500));
      }
    }
  };
  await new Promise((r) => (ws.onopen = r));

  await send("Runtime.enable");
  await send("Page.enable");

  const snap = (label) => async () => {
    const before = events.length;
    await send("Page.navigate", { url: label });
    await wait(2500);
    return events.length - before;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const BASE = process.env.REPRO_BASE ?? "http://localhost:3000";
  let resultSentinelSurvived = null; // set in step 3 (true = clean transition)
  out(`D-10 RangePicker repro — ${new Date().toISOString()} (${BASE}, headless Chrome)`);

  // 0) CONTROL SELF-TEST: prove the capture pipeline actually registers a
  //    console.error AND an uncaught page exception before trusting any
  //    "no events" result (a broken capture would be a false negative).
  await send("Page.navigate", { url: BASE });
  await wait(1500);
  await send("Runtime.evaluate", {
    expression: `(() => {
      console.error("D10-REPRO-CONTROL-MARKER");
      setTimeout(() => { throw new Error("D10-REPRO-CONTROL-THROW"); }, 50);
      return "control injected";
    })()`,
    returnByValue: true,
  });
  await wait(1500);
  const controlOk =
    events.some((e) => e.includes("D10-REPRO-CONTROL-MARKER")) &&
    events.some((e) => e.includes("D10-REPRO-CONTROL-THROW"));
  out(`[0] CONTROL: marker captured=${events.some((e) => e.includes("MARKER"))} throw captured=${events.some((e) => e.includes("THROW"))} → pipeline ${controlOk ? "PROVEN WORKING" : "BROKEN — results below are UNTRUSTED"}`);
  for (const e of events.splice(0)) out(`    ${e}`);

  // 1) initial load of / (hydration — where the dev-mode boundary error fires)
  await send("Page.navigate", { url: BASE + "/" });
  await wait(6000);
  const diag1 = await send("Runtime.evaluate", {
    expression: `JSON.stringify({ url: location.href, hasRange: !!document.getElementById('range-pick'), topbar: !!document.querySelector('.topbar'), accountCards: document.querySelectorAll('.card.stat').length })`,
    returnByValue: true,
  });
  out(`[1] GET / — DOM: ${diag1.result?.value ?? "?"} — events: ${events.length}`);
  for (const e of events.splice(0)) out(`    ${e}`);

  // 2) client-side navigation: click the first ad-account drill-down link
  //    (an <a> that stays inside the app → Next router, no full reload).
  const click = await send("Runtime.evaluate", {
    expression: `(() => {
      const a = [...document.querySelectorAll('a')].find((x) => x.getAttribute('href')?.startsWith('?adAccount='));
      if (a) { a.click(); return 'clicked ' + a.getAttribute('href'); }
      return 'no ad-account link found';
    })()`,
    returnByValue: true,
  });
  out(`[2] client-nav ${click.result?.value ?? "?"} — waiting…`);
  await wait(2500);
  out(`    new events: ${events.length}`);
  for (const e of events.splice(0)) out(`    ${e}`);

  // 3) client-side navigation: fire the RangePicker select (router.replace)
  //    using the React native-setter trick so the controlled <select>'s
  //    onChange actually fires (a bare .value= + dispatchEvent does NOT).
  //
  //    SENTINEL DISCRIMINATOR (the ticket's "capture the actual error /
  //    prove the fix"): a useSearchParams-without-Suspense range-select forces
  //    a full-document reload (CSR bailout) → the JS heap is wiped, so a
  //    sentinel set just before the select DISAPPEARS. A clean client-side
  //    transition (post-fix) preserves it. This is the reproducible before/after.
  await send("Runtime.evaluate", { expression: `window.__d10sentinel = 1; 'sentinel set'`, returnByValue: true });
  const range = await send("Runtime.evaluate", {
    expression: `(() => {
      const sel = document.getElementById('range-pick');
      if (!sel) return 'no #range-pick element';
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, '7d');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set range=7d via React-native change';
    })()`,
    returnByValue: true,
  });
  out(`[3] ${range.result?.value ?? "?"} — waiting…`);
  await wait(2500);
  const urlAfterRange = await send("Runtime.evaluate", { expression: `location.search`, returnByValue: true });
  const sentinel = await send("Runtime.evaluate", { expression: `window.__d10sentinel`, returnByValue: true });
  const sentinelSurvived = sentinel.result?.value === 1;
  out(`    URL after selection: ${urlAfterRange.result?.value ?? "?"} (range=7d present? ${String(urlAfterRange.result?.value ?? "").includes("range=7d")})`);
  out(`    sentinel ${sentinelSurvived ? "SURVIVED → clean client-side transition (NO full reload / no useSearchParams bailout)" : "GONE → PAGE FULLY RELOADED (the useSearchParams-bounded CSR bailout — the bug)"}`);
  out(`    new console/page events: ${events.length}`);
  for (const e of events.splice(0)) out(`    ${e}`);
  // Keep the discriminator in the RESULT line too.
  resultSentinelSurvived = sentinelSurvived;

  // 4) also the ?client=<id> + range combo the verification requires
  await send("Page.navigate", { url: BASE + "/?range=yesterday" });
  await wait(4000);
  out(`[4] GET /?range=yesterday (full load) — new events: ${events.length}`);
  for (const e of events.splice(0)) out(`    ${e}`);

  // Count real exceptions, excluding the control markers (and the control's
  // own PASS lines) so the self-test can't false-positive the result.
  const real = lines.filter((l) => !l.includes("D10-REPRO-CONTROL"));
  const hasErr = real.some((l) => l.includes("PAGEERROR") || /console\.error/.test(l));
  const verdict = !controlOk
    ? "CAPTURE PIPELINE BROKEN — re-run before trusting"
    : resultSentinelSurvived === false
      ? "BUG REPRODUCED: range-select caused a full-page reload (useSearchParams CSR bailout, no Suspense boundary)"
      : hasErr
        ? "EXCEPTION REPRODUCED in console (see events above)"
        : "CLEAN: range-select was a client-side transition (no reload, no console error)";
  out(`RESULT: ${verdict}`);
  fs.writeFileSync(OUT, lines.join("\n") + "\n");
  out(`evidence → ${OUT}`);

  try { ws.close(); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
  try { fs.rmSync("D:/Xacq-Track/.debug-chrome-profile", { recursive: true, force: true }); } catch {}
}

main().catch((e) => {
  console.error("repro crashed:", e);
  process.exitCode = 1;
});
