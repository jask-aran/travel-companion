import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import type { SiteSettings } from "../packages/wanderlog-import/src/config.js";

// Generated and gitignored so the repo carries no deployment's ids. It must be
// wrangler.jsonc at the repo root: `wrangler pages deploy` refuses `--config`.
export const PAGES_OUTPUT_DIR = "apps/web/.publish";

export function wranglerConfig(site: SiteSettings): Record<string, unknown> {
  const cloudflare = site.cloudflare;
  if (!cloudflare) {
    throw new Error("config/trip.local.yaml has no cloudflare section: this trip is not set up for Cloudflare Pages (run `pnpm trip:init` and choose deploy).");
  }
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: cloudflare.project,
    pages_build_output_dir: PAGES_OUTPUT_DIR,
    compatibility_date: "2026-10-19",
    compatibility_flags: ["nodejs_compat"],
    limits: { cpu_ms: 30000 },
    ...(cloudflare.kvNamespaceId ? { kv_namespaces: [{ binding: "TRIP", id: cloudflare.kvNamespaceId }] } : {}),
    // Without a bucket the function serves no photos or maps (503); every other route works.
    ...(cloudflare.mediaBucket ? { r2_buckets: [{ binding: "MEDIA", bucket_name: cloudflare.mediaBucket }] } : {}),
    vars: { PUBLIC_ID: site.publicId },
  };
}

export function wranglerConfigText(site: SiteSettings): string {
  return [
    "// Generated from config/trip.local.yaml by scripts/wrangler-config.ts. Do not edit:",
    "// `pnpm ship` and `pnpm trip:init` rewrite it. See wrangler.example.jsonc.",
    JSON.stringify(wranglerConfig(site), null, 2),
    "",
  ].join("\n");
}

export function writeWranglerConfig(root: string, site: SiteSettings): string {
  const path = resolve(root, "wrangler.jsonc");
  writeFileSync(path, wranglerConfigText(site), "utf8");
  return path;
}
