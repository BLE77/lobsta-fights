import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Integration tests hit a live server, so give them generous timeouts
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Don't watch by default (CI-friendly)
    watch: false,
  },
  resolve: {
    alias: {
      "~~": path.resolve(__dirname, "."),
    },
  },
});
