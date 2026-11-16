import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { localPassphrase, localSite, tripBundlePlugin } from "./vite/trip-bundle";
import { optionalFontsPlugin } from "./vite/optional-fonts";

/** Only the build encrypts: dev serves the working bundle as plaintext trip.json. */
const isBuild = process.argv.includes("build");
const tripEncrypted = isBuild && localPassphrase().length > 0;

/**
 * Where the app is served (`site.base` in config/trip.local.yaml, default
 * "/"; `TRIP_BASE` overrides). Every asset URL and the service worker scope
 * carry it.
 */
const site = localSite();
const base = site.base;
const liveProviders = isBuild || process.env.TRIP_LIVE_PROVIDERS === "1";

/**
 * Whether the Pages function (workers/refresh) is behind this app. A build has
 * it when the config has a cloudflare section; dev has it when there is a live
 * site (site.origin) to proxy to. `TRIP_FUNCTION=1` or `0` overrides either.
 */
const functionOverride = process.env.TRIP_FUNCTION;
const configuredFunction =
  functionOverride === "1" || functionOverride === "true"
    ? true
    : functionOverride === "0" || functionOverride === "false"
      ? false
      : isBuild
        ? Boolean(site.cloudflare)
        : Boolean(site.origin);
const hasFunction = liveProviders && configuredFunction;

/** Runtime caching for the Pages function's routes (photos, maps, live boards). */
const functionCaching = [
  {
    // Photos and maps never change for a place, so the copy on the
    // phone wins (offline-media.ts fills this cache up front). Only real
    // images: a blank "no photo" or "Google refused" answer is not kept here.
    urlPattern: /\/api\/(photo|map)\?/,
    handler: "CacheFirst" as const,
    options: {
      cacheName: "media",
      cacheableResponse: { statuses: [200], headers: { "x-media": "image" } },
    },
  },
  {
    // Live departure boards: the worker's answer when online, the
    // last one this phone got when not.
    urlPattern: /\/api\/departures\?/,
    handler: "NetworkFirst" as const,
    options: {
      cacheName: "live-departures",
      networkTimeoutSeconds: 5,
      expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 2 },
    },
  },
];

export default defineConfig({
  base,
  define: {
    __TRIP_ENCRYPTED__: JSON.stringify(tripEncrypted),
    __TRIP_BASE__: JSON.stringify(base),
    __TRIP_FUNCTION__: JSON.stringify(hasFunction),
    // Shown in the footer, so you can tell which shell a device is running.
    __APP_BUILT_AT__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    solid(),
    optionalFontsPlugin(),
    tripBundlePlugin(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false, // registered explicitly in src/index.tsx
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        id: base,
        name: "Travel Companion",
        short_name: "Trip",
        description: "Shared trip itinerary",
        theme_color: "#0b142e",
        background_color: "#0b142e",
        display: "standalone",
        display_override: ["standalone", "browser"],
        orientation: "portrait-primary",
        lang: "en",
        start_url: base,
        scope: base,
        icons: [
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // mjs: MapLibre's tile worker, so the Day map opens offline.
        globPatterns: ["**/*.{js,mjs,css,html,svg,png,ico,woff2,json}"],
        // `registerType: "autoUpdate"` does not set these in vite-plugin-pwa 1.x;
        // without them a new worker waits until every tab on the old one closes.
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // The trip is not precached: in the app-shell revision, every trip edit
        // would force a service-worker update before the app showed it.
        globIgnores: ["trip.json", "trip.enc"],
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            // The server's copy when online, so an open shows the latest
            // trip; the kept copy when offline or slow.
            urlPattern: /\/trip\.(json|enc)$/,
            handler: "NetworkFirst",
            options: {
              networkTimeoutSeconds: 4,
              cacheName: "trip-bundle",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // OpenFreeMap's style, fonts, icons and map tiles: a place seen once
            // is still drawn offline. Tiles for a planet build never change.
            urlPattern: /^https:\/\/tiles\.openfreemap\.org\//,
            handler: "CacheFirst",
            options: {
              cacheName: "base-map",
              expiration: { maxEntries: 4000, maxAgeSeconds: 60 * 60 * 24 * 60 },
              cacheableResponse: { statuses: [200] },
            },
          },
          // Only the Pages function answers these; a static build has neither.
          ...(hasFunction ? functionCaching : []),
        ],
      },
      devOptions: {
        // Dev SW is flaky; real install uses `pnpm build && pnpm preview` behind HTTPS.
        enabled: false,
      },
    }),
  ],
  server: {
    host: true, // 0.0.0.0 — phone/LAN/Tailscale
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
