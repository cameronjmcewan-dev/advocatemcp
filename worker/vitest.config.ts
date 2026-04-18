// worker/vitest.config.ts
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  resolve: {
    alias: {
      // Redirect the virtual `cloudflare:workers` import to a Node-friendly
      // stub so Vitest can load modules that extend `DurableObject`. The
      // real module only exists at runtime inside the Workers isolate.
      "cloudflare:workers": fileURLToPath(
        new URL("./test/__stubs__/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
