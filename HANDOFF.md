# Handoff: Day map and Google billing safety

Last updated 2026-11-16. Read this before shipping again.

## Goal

The Day map (`DayMap`, `apps/web/src/components/DayMap.tsx`) uses Google's Maps JavaScript API.
Google bills one map load each time a `google.maps.Map` is created. An earlier Places key was
drained by testing, which is why every server-side Google request is cached in R2 and counted
by the provider guard (`workers/refresh/guard.ts`). The Day map must keep that discipline.

## What is live

The last deploy (commit `d56594b`, 2026-11-16 19:02 AEDT) went out before the browser key existed.
**The live site shows OpenStreetMap (Leaflet) and makes no Maps JavaScript API calls.** The next
`pnpm ship` changes that, because `config/trip.local.yaml` now has `google.browserApiKey`.

## What is committed but not deployed

- **Explore map gate.** With a browser key, the Day map shows the cached day overview and an
  *Explore map* button. Google's map loads only after the tap. Changing days remounts `DayMap`
  (only the selected day renders), so each tap on a new day costs one billed load.
- **Day overview (`api/day-map`).** A Static Maps picture of the day, drawn by the worker from
  the stored trip (`dayMap` in `workers/refresh/media-routes.ts`, URL built by
  `apps/web/src/lib/day-map-preview.ts`). It is kept in R2 under
  `<PUBLIC_ID>/day-maps/<sha256 of the drawing>`, so every traveller shares one Google request per
  drawing. It goes through the same token check, guard and one-hour failure memory as `api/map`.
- **Cache-only checks.** Requests carrying the `x-trip-cache-only: 1` header (`CACHE_ONLY_HEADER`)
  use `cacheOnlyGuard`: they read R2 but never ask a provider and skip the idle Wanderlog refresh.
  `pnpm ship:check` (`scripts/verify-live.ts`) sends it on every request.
- **Dev makes no paid calls by default.** `pnpm dev` returns 503 for media and departure routes
  and ships no browser key unless `TRIP_LIVE_PROVIDERS=1` is set.

Tests: `tests/media-storage.test.ts` covers the day overview (one Google call, then R2 hits;
nothing asked for an unknown day, a stale revision or a bad token) and cache-only mode.

## Not yet verified

- The gate and overview have not been checked visually in a browser.
- No live Static Maps request has been made for a day overview, so the URL length limit and
  marker labels are only checked by code reading.
- `google.mapId` is not set, so the map uses `DEMO_MAP_ID`. Advanced markers need a map ID;
  whether Google's demo ID suits production has not been checked.

## Operator actions still open

1. Restrict the browser key in Google Cloud: API restriction *Maps JavaScript API* only, website
   restriction `https://trips.jask-aran.com/*` and `http://localhost:5173/*`. The operator chose
   no restrictions; the key is public in the shipped JavaScript once deployed.
2. Set a daily request quota on Maps JavaScript API and Maps Static API in the project's
   *Quotas* page. The worker guard does not see browser map loads; Google's quota is the only cap.
3. Consider a budget alert on the billing account.

## Next steps

- After the operator agrees, `pnpm ship`, then open one day and tap *Explore map* once.
- Possible later saving: keep one `google.maps.Map` alive across day changes instead of one per
  mount.
