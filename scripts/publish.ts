import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSiteSettings } from "../packages/wanderlog-import/src/config.js";

/**
 * Stage the build for Cloudflare Pages. Vite's `base` rewrites URLs but does
 * not move files, and Pages serves the folder at the site root, so the build
 * is nested under `site.base` or every asset 404s.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = readSiteSettings(resolve(root, "config/trip.local.yaml"));
const base = site.base.replace(/^\/|\/$/g, "");

const dist = resolve(root, "apps/web/dist");
const publishDir = resolve(root, "apps/web/.publish");
const target = resolve(publishDir, base);

await rm(publishDir, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });

console.log(`Staged ${dist}`);
console.log(`     -> ${target}`);
if (site.cloudflare) {
  console.log(`Deploy with: wrangler pages deploy apps/web/.publish --project-name ${site.cloudflare.project} --branch main --commit-dirty`);
}
