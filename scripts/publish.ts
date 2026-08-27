import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage the build for Cloudflare Pages.
 *
 * The app is served from a path (`/japankorea2026/`), and Vite's `base` only
 * rewrites URLs *inside* the HTML — it does not move the files. Pages serves
 * the uploaded directory at the site root, so the build has to be nested in a
 * folder of the same name or every asset 404s into the SPA fallback.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = (process.env.TRIP_BASE ?? "/japankorea2026/").replace(/^\/|\/$/g, "");

const dist = resolve(root, "apps/web/dist");
const publishDir = resolve(root, "apps/web/.publish");
const target = resolve(publishDir, base);

await rm(publishDir, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(dist, target, { recursive: true });

console.log(`Staged ${dist}`);
console.log(`     -> ${target}`);
console.log(`Deploy with: npx wrangler pages deploy apps/web/.publish --project-name jask-aran`);
