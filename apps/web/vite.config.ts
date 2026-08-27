import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { VitePWA } from "vite-plugin-pwa";
import { localGoogleApiKey, localPassphrase, tripBundlePlugin } from "./vite/trip-bundle";

/**
 * Google Place Photos cannot be cached or re-hosted, so the browser fetches
 * them directly and the key ships in the bundle. Restrict it by HTTP referrer.
 * With no key set, the app simply renders no photos.
 */
const googleMapsKey = localGoogleApiKey();
/** Dev always serves plaintext; a configured passphrase encrypts the build. */
const tripEncrypted = localPassphrase().length > 0;

/**
 * Served from a path, not a host root, so every asset URL and the service
 * worker scope must carry it. Overridable for a different deployment.
 */
const base = process.env.TRIP_BASE ?? "/japankorea2026/";

export default defineConfig({
  base,
  define: {
    __GOOGLE_MAPS_KEY__: JSON.stringify(googleMapsKey),
    __TRIP_ENCRYPTED__: JSON.stringify(tripEncrypted),
    __TRIP_BASE__: JSON.stringify(base),
  },
  plugins: [
    solid(),
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
        theme_color: "#0B1F33",
        background_color: "#0B1F33",
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
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2,json}"],
        // The trip payload is deliberately NOT precached. Precaching it would
        // put ~430 KB of content into the app-shell revision, so every trip
        // edit would force a full service-worker update cycle before the app
        // could show new data. Runtime caching below serves it instantly from
        // cache and refreshes it in the background instead.
        globIgnores: ["trip.json", "trip.enc"],
        navigateFallback: `${base}index.html`,
        runtimeCaching: [
          {
            urlPattern: /\/trip\.(json|enc)$/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "trip-bundle",
              expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
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
