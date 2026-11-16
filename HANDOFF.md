# Handoff: Day map

Last updated 2026-11-16. Read this before shipping again.

## Decision

The Day map (`DayMap`, `apps/web/src/components/DayMap.tsx`) is drawn by **MapLibre GL** on the
phone over OpenFreeMap's **Liberty** style, used as published. No Google API is used for it.

Why not Google's Maps JavaScript API: it bills per map created, its tiles can't be cached at
Cloudflare (terms §3.2.3 forbid storing Google Maps content), and its map data in South Korea is
thin. OpenFreeMap needs no key and has no bill. The operator chose "clean, recognisable, like
Google" over a custom-designed base map, so the style is not restyled; only our route and pins
are ours.

## How it fits together

- `apps/web/src/lib/maplibre-view.ts` mounts the map and returns a `DayMapView`. It fetches the
  Liberty style once per page; if that fails (offline), it draws the route and pins on a blank
  base and the Day map shows "Street map unavailable".
- Route: one GeoJSON source (`journey-route`) with casing, solid, approximate (dashed), walk
  (dotted) and flight (dashed, hidden until Whole day) layers, plus arrowheads in each line's
  colour.
- Pins: the existing `journey-pin` artwork (`map-pin.ts`) inside a zero-size `.day-map__pin`
  MapLibre marker. `declutter()` hides captions (never badges) that would cover a more important
  pin or the Ground route / Whole day switch: selected, then Start/Finish, then points of interest.
- Gestures: two fingers move the map (`cooperativeGestures`), no rotation or tilt.
- Offline: the service worker precaches MapLibre (`*.mjs` included) and keeps OpenFreeMap style,
  fonts and tiles in the `base-map` cache (CacheFirst, 4000 entries, 60 days).
- In dev only, `window.dayMap` is the live map, for inspecting layers.

## Removed

Google's interactive renderer, the Explore map gate, the `api/day-map` Static Maps overview,
Leaflet, `@googlemaps/js-api-loader`, and the `google.browserApiKey` / `google.mapId` config keys
(old values in `config/trip.local.yaml` are ignored).

## Also in place

- `x-trip-cache-only: 1` (`CACHE_ONLY_HEADER`) makes the worker read R2 only; `pnpm ship:check`
  sends it, so checks never spend Google or NAVITIME quota.
- `pnpm dev` asks no paid provider unless `TRIP_LIVE_PROVIDERS=1`.

## Not verified

- Only checked in desktop Chromium at a 412px-wide viewport, not on a phone.
- Offline opening of a previously viewed map has not been tried.
- The station label classes in Liberty were not checked against Japanese and Korean data beyond
  the screenshots.

## Known open items

- `api/map` (stay cards' street map) still stores Google Static Maps images in R2, which Google's
  FAQ says not to do. It could move to a MapLibre snapshot.
- After billing was restored, the live guard's breaker held Google closed until 19:59 on
  2026-11-16; `pnpm ship:check` reports that as FAIL until it lapses.
