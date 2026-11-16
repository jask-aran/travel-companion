# Handoff: Day map

Last updated 2026-11-17. Read this before shipping again.

## Decision

The Day map (`DayMap`, `apps/web/src/components/DayMap.tsx`) is drawn by **MapLibre GL** on the
phone over OpenFreeMap's vector tiles, in **our own style** (`apps/web/src/lib/map-style.ts`),
light and dark. No Google API is used for it.

Why not Google's Maps JavaScript API: it bills per map created, its tiles can't be cached at
Cloudflare (terms §3.2.3 forbid storing Google Maps content), and its map data in South Korea is
thin. OpenFreeMap needs no key and has no bill.

On 2026-11-17 the operator replaced "Liberty as published" with a style of our own: clean like
Liberty, but closer to Google in using colour to say what an area is, and with a dark mode.
The layer structure and label expressions follow OSM Liberty / OSM Bright (BSD-3 code,
CC BY 4.0 design, credited in the attribution); every colour is ours.

## How it fits together

- `map-style.ts` builds the style from one layer list and two palettes (`PALETTES.light`,
  `PALETTES.dark`), so both themes always have the same layers. Colour carries meaning:
  - land use: parks green, hospitals pink, schools tan, shopping streets peach, industry violet;
  - points of interest, by category (`POI_CLASSES`): food orange, shops blue, sights and
    temples teal, nature green, health red, lodging pink, transit navy. "Other" points
    (offices, gates) wait until zoom 17.
- `map-icons.ts` draws the POI markers (a coloured disc with a glyph) on a canvas. OpenFreeMap's
  sprite has no recolourable (SDF) icons. They are re-added on every `style.load`.
- `maplibre-view.ts` mounts the map and returns a `DayMapView`:
  - `fit()`: the whole day.
  - `focus()`: frames the leg into a visit and fades the other legs (feature-state `dim`).
  - `setTheme()`: swaps the style; the route and markers are re-added in the new colours.
  - Never pass `padding` to `easeTo`/`flyTo`: MapLibre keeps it on the map, and every later
    `fitBounds` subtracts it again, so on a phone the fit can't fit and does nothing (Fit day,
    Ground route and Whole day went dead this way). `focusStop` uses `offset`, and every fit
    clears padding first.
  - `setInteractive()`: one-finger panning on or off.
  - Tile errors show "Street map unavailable", with the route still drawn on the plain ground.
- Route: one GeoJSON source (`journey-route`) with casing, solid, approximate (dashed), walk
  (dotted, slate) and flight (dashed, hidden until Whole day) layers, plus arrowheads. Each
  `MapPath` carries `fromVisitId`/`toVisitId`, so a place visited twice (Kamakura "7·9") steps
  to the right leg. `legInto()` finds the leg arriving at a visit.
- Pins: `journey-pin` artwork (`map-pin.ts`) in a zero-size `.day-map__pin` marker.
  `declutter()` shrinks a pin crowded under a more important one to a dot (`journey-pin--dot`)
  and hides captions that would cover a more important pin or anything marked
  `data-map-overlay`. The fit padding is measured from those overlays too.
- **Map mode.** A Day map with places is a full-screen-height card (`100svh` below the day tabs)
  and, when the day has more than 60% of a screen above it, a scroll-snap point
  (`.day-map--snap`, `html:has(.day-map--snap) { scroll-snap-type: y proximity }`).
  - When scrolling comes to rest with it aligned, it engages (`day-map--engaged`):
    `cooperativeGestures` is turned off, so one finger pans.
  - Moving the page away disengages it at once. The snap is only for coming in: once engaged,
    the map stops being a snap point until the page is half a screen away (`snapRested`).
    Without that, Chrome resolves a wheel scroll away straight back onto the map.
  - Done, or dragging the heading or step card, scrolls back out.
  - The app's own scrolls (day tabs, `scrollToDay`, `pinOnScreen`) call `holdMapSnap()`
    (`lib/map-snap.ts`) so they never snap onto the map.
- **Dock** (`journey-map__dock`): floats over the map's foot, so the map keeps its full height.
  It holds a translucent legend and the step card, and counts as a `bottom` overlay for padding
  and decluttering. The zoom buttons and attribution sit at the top right.
- **Step card** (`journey-map__step`): the day one step at a time, Start, then each leg followed
  by the stop it arrives at, with ‹ › in its header.
  - Stops and legs are drawn by `DaySection` through `renderStop` and `renderLeg`. They are the
    Day route's own `PlaceRow` and `RouteLegRow`, so a stop shows its photo, hours, rating and
    notes, and a leg shows its departure board, line and earliest departure (`MapPath.leg` and
    `MapPath.planKey`).
  - A flight or bare connection, which has no route leg, gets a one-line summary.
  - The map follows the step: a leg is framed with the other legs faded (`focusLeg`), a stop is
    shown close up (`focusStop`), and Start shows the whole day.
- **Step strip** (`journey-map__stops`): the step card's other mode, behind its list button.
  Every stop and leg in a row, legs as dashed chips with their time; tapping one jumps there.
- **Trip menu** (`TripMenu`): the header's More button, a native popover. It holds the app
  version ("Get latest app version") and the connector link ("Copy connector link"), which used
  to be the itinerary footer.
- **Landing in map mode:** a thud haptic, the card settles with a small spring and its edge
  glows, the map controls drop in and the dock rises, and Done slides in. Leaving gives a
  selection haptic. Stepping slides the card the way you went, and the new stop's pin pops. All
  of it is off for reduced motion. The step buttons sit at the card's foot, so they stay put
  while the card's height changes.
- **Haptics** (`lib/haptics.ts`): selection (day tabs, steps, chips, pins, scope switch, via
  `data-haptic="selection"`), tick (other buttons), thud (map mode), success and failure (refresh,
  copy). Android uses the Vibration API. iOS has none, so each pulse toggles a hidden
  `<input type="checkbox" switch>`. That is an iOS 18 workaround with one strength, and it is
  untested on a device.
- Offline: the service worker keeps OpenFreeMap fonts and tiles in the `base-map` cache
  (CacheFirst). The style itself is in the bundle now.
- In dev only, `window.dayMap` is the live map, for inspecting layers.

## Removed

Google's interactive renderer, the Explore map gate, the `api/day-map` Static Maps overview,
Leaflet, `@googlemaps/js-api-loader`, and the `google.browserApiKey` / `google.mapId` config keys
(old values in `config/trip.local.yaml` are ignored).

On 2026-11-17: the fetched Liberty style and its blank fallback, the bookends row above the map,
and the Expand/Shrink button (map mode replaces it).

## Also in place

- `x-trip-cache-only: 1` (`CACHE_ONLY_HEADER`) makes the worker read R2 only; `pnpm ship:check`
  sends it, so checks never spend Google or NAVITIME quota.
- `pnpm dev` asks no paid provider unless `TRIP_LIVE_PROVIDERS=1`.

## Not verified

- Dev has no photos or departure boards unless `TRIP_LIVE_PROVIDERS=1`, and the local trip has no
  boards. Both were checked on the live site after `pnpm ship` on 2026-11-17.
- Only checked in desktop Chromium at a 412px-wide viewport, not on a phone. The snap's feel,
  one-finger panning on real touch, and iOS Safari (no `scrollend`; a 120ms debounce stands in)
  are unproven.
- Offline opening of a previously viewed map has not been tried.
- The station label classes in Liberty were not checked against Japanese and Korean data beyond
  the screenshots.

## Known open items

- `api/map` (stay cards' street map) still stores Google Static Maps images in R2, which Google's
  FAQ says not to do. It could move to a MapLibre snapshot.
- After billing was restored, the live guard's breaker held Google closed until 19:59 on
  2026-11-16; `pnpm ship:check` reports that as FAIL until it lapses.
