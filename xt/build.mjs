/**
 * Build the tracking script to a single, tiny, browser-safe bundle.
 * Output: public/xt.js  (spec: < 10 KB, no page-speed impact).
 * Run via `pnpm xt:build` (wired to `node xt/build.mjs`, so no esbuild dep needed).
 */
import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "src", "index.ts");
const out = join(here, "..", "public", "xt.js");

await mkdirSync(dirname(out), { recursive: true });

await build({
  entryPoints: [entry],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2018"],
  // This file is a plain browser script; no externals.
  outfile: out,
  logLevel: "info",
});

const bytes = statSync(out).size;
const KB = (bytes / 1024).toFixed(2);
const ok = bytes < 10 * 1024;
console.log(`xt.js -> ${out}  (${KB} KB)  ${ok ? "OK (<10KB)" : "!! OVER BUDGET (>=10KB)"}`);
if (!ok) process.exitCode = 1;
