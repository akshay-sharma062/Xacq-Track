import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Domain modules are framework-free; keep them under Node for `node:crypto`.
    pool: "forks",
  },
});
