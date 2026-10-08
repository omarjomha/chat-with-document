import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Live verification against the real YouTube API.
 *
 * Separate from vitest.config.mts on purpose: these checks need the network,
 * are subject to YouTube rate limiting, and must never run in CI or as part of
 * `npm test`. Run them deliberately with `npm run verify:youtube`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws by design outside a server bundle; stub it so the
      // real ingest module can be exercised directly.
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.ts"],
    // One network round trip per client, plus the caption document.
    testTimeout: 60_000,
    // Sequential: concurrent requests are the fastest way to get rate limited.
    fileParallelism: false,
    pool: "forks",
  },
});
