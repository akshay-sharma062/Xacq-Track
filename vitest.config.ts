import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // D-14: alias the tsconfig `@/*` path so a route module under test
    // (src/app/api/...) can load its `@/lib/*` deps under vitest. Inert for
    // the lib-layer tests (they import via relative paths).
    alias: { "@": path.resolve(process.cwd(), "src") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Domain modules are framework-free; keep them under Node for `node:crypto`.
    pool: "forks",
  },
});
