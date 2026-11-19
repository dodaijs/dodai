import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "node", environment: "node", include: ["test/*.spec.ts"] },
      },
      {
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            wrangler: { configPath: "./test/workers/wrangler.jsonc" },
          }),
        ],
        test: { name: "workers", include: ["test/workers/*.spec.ts"] },
      },
    ],
  },
});
