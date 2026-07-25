# Wanderlog Itinerary PWA — Project Specification

## 1. Objective

Build a fast, mobile-first PWA that reproduces the useful interaction model of Wanderlog’s itinerary page without reproducing the wider Wanderlog product.

The application is a single continuous itinerary for one trip. Users must be able to:

- scroll continuously through every trip day;
- jump to any day using a sticky horizontal date header;
- see each stop as a visually grounded card;
- see notes, times, travel legs, flights, accommodation, and other itinerary blocks inline;
- reveal or hide a map using a floating control;
- keep the map synchronised to the day currently in view;
- open any stop directly in Google Maps from the device’s current location;
- install the PWA before departure;
- receive itinerary updates after installation.

The organiser owns ingestion and publishing. Other travellers are initially read-only users.

The itinerary itself is the product. Do not build separate budget, calendar, reference, or map products for the initial release.

## 2. Scope

### In scope

- one continuous vertically scrollable itinerary;
- sticky date navigation;
- day headings and subtle separation;
- stop cards with representative images;
- inline notes and typed itinerary blocks;
- inline travel-leg presentation;
- floating map reveal;
- map synchronisation with the active day;
- Google Maps handoff;
- Wanderlog CLI JSON ingestion;
- HTML/MobX-state scraping as backup ingestion;
- privacy-safe normalisation;
- manual overrides;
- static publishing and installed-client updates;
- optional live editing later.

### Out of scope

- Markdown ingestion;
- budget or expense features;
- separate calendar, reference, or full-screen map screens;
- recommendation discovery;
- booking search;
- general trip creation;
- two-way synchronisation back to Wanderlog;
- turn-by-turn navigation;
- automatic itinerary optimisation;
- offline map packaging;
- full collaborative editing;
- CRDTs or live presence.

## 3. System boundary

```text
Wanderlog CLI JSON ─────┐
                        ├─> shared parser/normaliser ─> TripBundle revision
Wanderlog page scraper ─┘                                  │
                                                           ├─> static publishing
                                                           └─> optional live backend
```

The PWA consumes only the canonical `TripBundle`. It must not understand Wanderlog’s internal schema or fetch Wanderlog at runtime.

## 4. Repository architecture

Use a TypeScript monorepo.

```text
wanderlog-itinerary-pwa/
├─ apps/
│  ├─ web/
│  └─ server/                    # optional until live editing exists
├─ packages/
│  ├─ trip-schema/
│  ├─ wanderlog-import/
│  ├─ trip-normaliser/
│  ├─ trip-diff/
│  └─ trip-publisher/
├─ private-import/               # gitignored raw JSON, HTML, overrides
├─ public-data/
│  └─ trips/
├─ scripts/
├─ pnpm-workspace.yaml
└─ package.json
```

Preferred tooling:

- Node.js LTS;
- pnpm workspaces;
- TypeScript strict mode;
- SolidJS;
- Vite;
- Vitest;
- Playwright;
- Biome;
- `tsx` for scripts.

## 5. Ingestion architecture

### 5.1 Primary source: Wanderlog CLI JSON

```bash
wanderlog trips show <trip-id> \
  --output json \
  > private-import/wanderlog-trip.json
```

The CLI JSON is the preferred input because it contains structured sections, ordered blocks, dates, times, places, coordinates, Google Place IDs, notes, flights, accommodation, route metadata, image metadata, and source identifiers.

Project command:

```bash
pnpm trip:import private-import/wanderlog-trip.json
```

### 5.2 Backup source: Wanderlog page scraper

Provide a scraper or extraction script that retrieves or accepts the Wanderlog trip HTML and extracts:

```js
window.__MOBX_STATE__.tripPlanStore.data
```

Supported backup modes:

- Playwright using a persistent authenticated browser profile;
- parser for a manually saved HTML file;
- browser-side export script.

The parser must locate the `window.__MOBX_STATE__` assignment, decode the embedded object using a real JSON parser, extract the trip-plan data, and pass it into the same normalisation path as CLI JSON.

Do not scrape rendered cards or depend on CSS selectors while embedded state exists. Fail clearly if the state path changes.

### 5.3 Source unification

```text
CLI response ────────────┐
                         ├─> WanderlogSourceData ─> TripBundle
HTML MobX state ─────────┘
```

Do not maintain separate CLI and HTML normalisers.

### 5.4 Manual overrides

Use:

```text
private-import/overrides.yaml
```

Overrides are for:

- hiding exact addresses;
- changing public display names;
- selecting or replacing a representative image;
- correcting coordinates;
- adding missing times;
- marking stops tentative or optional;
- resolving ambiguities.

Use stable Wanderlog block IDs or Google Place IDs as keys.

### 5.5 Import outputs

```text
public-data/trips/<trip-id>/working.json
private-import/import-report.json
private-import/import-report.md
```

The report should include imported counts, missing coordinates, missing images, ambiguous duplicates, redacted fields, applied overrides, privacy warnings, and a source fingerprint.

## 6. Canonical TripBundle

```ts
export interface TripBundle {
  schemaVersion: number;
  tripId: string;
  revision: string;
  generatedAt: string;

  trip: TripSummary;
  days: TripDay[];
  places: Record<string, Place>;
  routeLegs: Record<string, RouteLeg>;
}

export interface TripSummary {
  title: string;
  startDate: string;
  endDate: string;
}

export interface TripDay {
  id: string;
  date: string;
  title: string;
  subtitle?: string;
  timezone: string;
  items: DayItem[];
  map: {
    orderedPlaceIds: string[];
    routeLegIds: string[];
    defaultViewport?: MapViewport;
  };
}

export type DayItem =
  | PlaceItem
  | TransitItem
  | FlightItem
  | LodgingItem
  | NoteItem;

export interface Place {
  id: string;
  sourceBlockId?: number;
  googlePlaceId?: string;
  name: string;
  category?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  ratingCount?: number;
  image?: PlaceImage;
}

export interface PlaceImage {
  source: "wanderlog" | "google-places" | "manual" | "fallback";
  url?: string;
  sourceKey?: string;
  width?: number;
  height?: number;
  attribution?: {
    label?: string;
    uri?: string;
  };
  sourcePageUri?: string;
}

export interface RouteLeg {
  id: string;
  fromPlaceId: string;
  toPlaceId: string;
  travelMode:
    | "walking"
    | "transit"
    | "driving"
    | "cycling"
    | "ferry"
    | "flight";
  distanceMetres?: number;
  durationSeconds?: number;
  encodedPolyline?: string;
}
```

Use Valibot by default, with Zod as an alternative. Validate source adapters, generated bundles, published revisions, and revisions downloaded by the PWA.

## 7. Representative place images

Each place card should show one compact representative image where available. The image is for visual grounding, not a gallery.

### 7.1 Wanderlog `imageKey`

Some place and geo resources contain fields such as:

```json
{
  "name": "Kanazawa",
  "imageKey": "zJo3r9KUh6n5b2JlJd74gKXQVRM8Bohs"
}
```

This appears to be a Wanderlog-managed image identifier used by Wanderlog’s image service/CDN. The importer should determine the current URL construction from page or network behaviour and resolve it during ingestion.

Do not make installed clients depend on undocumented Wanderlog image-key URL construction. Prefer publishing a resolved stable URL or a locally hosted derivative where permitted.

### 7.2 Google `photos[].photo_reference`

Google Place objects also contain:

```json
{
  "height": 3024,
  "width": 4032,
  "photo_reference": "...",
  "html_attributions": []
}
```

These are photo tokens, not direct image URLs. They require a Places Photo API request.

Do not treat them as durable assets. Google photo identifiers can expire, caching is restricted, and attribution/source-access requirements apply.

### 7.3 Selection order

1. manual override;
2. resolved Wanderlog `imageKey`;
3. current Google Places photo resolved using the Google Place ID;
4. category/location fallback;
5. no image.

Do not publish full photo arrays.

### 7.4 Image UI

- fixed aspect ratio;
- lazy loading;
- responsive sizing;
- no layout shift;
- graceful fallback;
- image should not dominate the card;
- no carousel;
- show attribution/source access when required.

## 8. PWA interaction model

### 8.1 Continuous itinerary

The main route renders every day in one vertical stack:

```text
Sticky date header
Day 1
  stop
  travel leg
  stop

Day 2
  stop
  note
  stop
```

Each day is a semantic section with a stable anchor:

```html
<section id="day-2026-11-24">
```

The day tabs scroll to those anchors.

### 8.2 Sticky date header

The header remains fixed, contains horizontally scrollable day tabs, highlights the active day, keeps the active tab visible, and supports tap-to-scroll.

Use `IntersectionObserver` to determine the active day. Do not perform high-frequency scroll-position calculations across every section.

When a tab is tapped:

- update selection immediately;
- scroll the day into view;
- respect reduced-motion preferences;
- avoid observer feedback causing visible tab flicker.

### 8.3 Day separation

Days should feel continuous but distinct through whitespace, heading, date, optional city/subtitle, and a subtle divider or background transition.

Do not create a separate page shell per day.

### 8.4 Stop cards

A stop card should contain:

- representative image;
- sequence marker;
- place name;
- time;
- category or short label;
- concise note preview;
- Google Maps action;
- expandable details where useful.

The directions action must be immediate. Do not require a separate place-details page first.

### 8.5 Inline blocks

Flights, accommodation, transit, and notes remain in the continuous flow with specialised card treatments.

## 9. Map interaction

### 9.1 Hidden by default

A floating map button toggles the map.

Collapsed:

```text
┌──────────────────────────┐
│ sticky day tabs          │
├──────────────────────────┤
│ continuous itinerary     │
│                [Map]     │
└──────────────────────────┘
```

Expanded:

```text
┌──────────────────────────┐
│ map for active day       │
│                          │
├──────────────────────────┤
│ sticky day tabs          │
│ itinerary continues      │
│                [Close]   │
└──────────────────────────┘
```

The map reveal moves the itinerary viewport downward rather than covering it with a full-screen overlay.

### 9.2 Layout implementation

Preferred:

- CSS grid or flex root layout;
- map panel expands from zero to about `50dvh`;
- itinerary remains the scroll owner;
- sticky date header stays at the top of the itinerary pane;
- floating button respects safe-area insets;
- call `map.resize()` after the transition;
- preserve itinerary scroll position.

Avoid resizing the map expensively on every animation frame.

### 9.3 Map follows active day

The map displays one day at a time.

As the user crosses a day boundary:

- active day changes through `IntersectionObserver`;
- marker set changes;
- route geometry changes;
- map fits or eases to the active day;
- camera changes are debounced.

When hidden, update only active-day state. Do not perform camera work until the map is visible.

### 9.4 Renderer

Use one MapLibre GL JS instance and a commercial OpenStreetMap-derived tile provider such as MapTiler, Stadia Maps, Mapbox, or another suitable provider.

Do not use public OpenStreetMap tile servers as production infrastructure.

Use stored Wanderlog polylines where available; otherwise draw simple lines between ordered stops. The map is overview context, not authoritative navigation.

## 10. Google Maps handoff

Destination priority:

1. Google Place ID plus coordinates;
2. coordinates;
3. approved address;
4. name plus city/region.

Use Google Maps URLs and omit the origin so Google Maps uses the current device location.

Transit is the default, with walking or driving where relevant.

## 11. State and performance

Use:

- one immutable active TripBundle;
- active day derived from observed day sections;
- one map instance;
- local card-expansion state;
- IndexedDB for validated revisions;
- service-worker caching for application assets.

Do not:

- duplicate the itinerary across stores;
- attach listeners to every card;
- refit the map on every scroll event;
- decode every image eagerly;
- block first render on update checks;
- mount one map per day.

## 12. Publishing and updates

Publish:

```text
/trips/<trip-id>/manifest.json
/trips/<trip-id>/revisions/<revision>.json
```

On launch or resume:

1. load the last validated revision from IndexedDB;
2. render immediately;
3. fetch the manifest;
4. compare revisions;
5. fetch a new revision if needed;
6. validate schema and hash;
7. replace local state atomically;
8. retain the previous revision for rollback.

Preferred initial host: Cloudflare Pages.

Alternatives: GitHub Pages, Netlify, Vercel, or a VPS with Caddy.

## 13. Optional live-editing backend

The static PWA must not depend on the backend.

If introduced:

```text
imported itinerary
+ organiser overrides
+ user edits/overlays
= published client snapshot
```

Possible features:

- edit stop notes;
- change a time;
- mark a stop skipped;
- reorder stops;
- add a stop;
- remove a stop.

Preferred stack:

- Hono or Fastify;
- Drizzle;
- SQLite in WAL mode for six users;
- PostgreSQL as an alternative;
- REST for writes;
- SSE to announce revisions;
- Caddy;
- Docker Compose;
- Litestream for SQLite backups.

Use optimistic concurrency with revision IDs or ETags.

Do not mutate raw imported Wanderlog data directly. Do not add CRDTs unless simultaneous editing becomes a real requirement.

## 14. Anti-patterns

### Ingestion

- no Markdown adapter;
- no runtime Wanderlog dependency;
- no DOM scraping while MobX state exists;
- no separate CLI and HTML normalisers;
- no regex parsing of nested JSON;
- no raw exports in the public build;
- no deny-list-only privacy strategy;
- no manual edits to generated bundles;
- no silently guessed places or images.

### Images

- no full Google photo arrays;
- no permanent use of `photo_reference`;
- no omitted required attribution;
- no undocumented Wanderlog hotlinks without fallback;
- no eager loading of every image;
- no itinerary image carousels.

### UI

- no dashboard;
- no separate calendar, budget, reference, or map product;
- no per-day page requirement;
- no one-map-per-day implementation;
- no high-frequency raw scroll calculations;
- no camera update for every minor scroll movement;
- no compulsory details screen before directions;
- no full-screen map overlay as the default interaction.

### Publishing and live editing

- no mutable unversioned `trip.json`;
- no blocking first render on network;
- no direct mutation of imported records;
- no two-way Wanderlog sync;
- no WebSockets where SSE is sufficient;
- no CRDTs by default;
- no VPS dependency for the read-only app.

## 15. Implementation phases

### Phase 1: ingestion and schema

- CLI JSON importer;
- HTML/MobX scraper and parser;
- shared source model;
- normaliser;
- image resolution policy;
- overrides;
- validation;
- privacy scan;
- first TripBundle.

### Phase 2: continuous itinerary PWA

- SolidJS shell;
- continuous day stack;
- sticky date tabs;
- active-day observation;
- stop cards;
- representative images;
- inline specialised blocks;
- Google Maps handoff;
- PWA installation.

### Phase 3: map interaction

- floating map toggle;
- half-height reveal;
- active-day markers and route;
- camera debouncing;
- hidden-map performance behaviour.

### Phase 4: publishing and updates

- immutable revisions;
- manifest;
- semantic diff;
- client update flow;
- rollback;
- static deployment.

### Phase 5: optional backend

- authentication;
- write API;
- optimistic concurrency;
- overlay data model;
- SSE;
- audit log;
- backups.

## 16. Default choices

```text
Frontend
- SolidJS
- TypeScript
- Vite
- vite-plugin-pwa
- MapLibre GL JS
- Kobalte
- Valibot
- idb
- date-fns

Interaction
- IntersectionObserver
- one itinerary scroll container
- one map instance
- CSS grid/flex map reveal
- lazy-loaded place images

Ingestion
- wanderlog-cli JSON primary
- Playwright/manual HTML MobX scraper backup
- shared normaliser
- YAML overrides
- allow-list publication

Publishing
- immutable TripBundle revisions
- manifest pointer
- Cloudflare Pages
- Git-based deployment initially

Future backend
- Hono or Fastify
- Drizzle
- SQLite + WAL/Litestream initially
- PostgreSQL alternative
- REST + SSE
- Caddy
- Docker Compose
```

## 17. Acceptance criteria

- CLI JSON imports successfully;
- HTML extraction produces equivalent canonical data;
- no Markdown adapter exists;
- every trip day appears in one continuous itinerary;
- sticky tabs jump to days and follow scroll position;
- stop cards use representative images where available;
- all stops open in Google Maps;
- the floating map control reveals a half-height map;
- the map tracks the active day;
- the map remains lightweight while hidden;
- the PWA installs correctly;
- itinerary revisions publish independently of application code;
- installed clients receive and validate revisions;
- raw Wanderlog data is never exposed publicly.
