import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@travel-companion/trip-schema": new URL(
        "./packages/trip-schema/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
