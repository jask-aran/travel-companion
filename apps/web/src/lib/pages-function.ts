/**
 * Whether the Pages function (workers/refresh) answers this app's `api/*`
 * and `mcp/*` routes. Set at build time (vite.config.ts): true for a
 * Cloudflare Pages deployment, false for plain static files, where refresh,
 * the connector link, photos, maps and live boards are left out. In dev it
 * means the dev server can proxy photos, maps and boards to the live site.
 */
declare const __TRIP_FUNCTION__: boolean;
export const hasPagesFunction = typeof __TRIP_FUNCTION__ === "boolean" ? __TRIP_FUNCTION__ : false;
