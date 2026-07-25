# Travel Companion

A fast, mobile-first PWA for viewing a shared trip itinerary.

The app is centred on one continuous, vertically scrollable itinerary with sticky day navigation, representative place images, inline travel details, a floating half-height map, and direct Google Maps handoff for navigation.

Trip data is acquired and normalised through one orchestrated ingestion command. Wanderlog CLI JSON is the primary source; an integrated Playwright scraper retrieves the Wanderlog page and extracts embedded MobX state when the CLI fails.

## Ingestion

Requirements: Node.js 22+, pnpm, Wanderlog CLI, and Playwright Chromium.

```bash
pnpm install
pnpm exec playwright install chromium
pnpm trip:refresh
```

`trip:refresh` reads `config/trip.yaml`, which contains the Wanderlog trip ID, canonical page URL, source paths, browser-profile path, and generated-bundle path.

The command:

1. runs `wanderlog trips show <configured-id> --output json`;
2. validates and saves the raw JSON;
3. falls back to Playwright scraping when CLI acquisition fails;
4. extracts `window.__MOBX_STATE__.tripPlanStore.data` from the scraped HTML;
5. runs both sources through the same normaliser;
6. writes the validated working `TripBundle` and private reports.

Useful forced modes:

```bash
pnpm trip:pull             # CLI only
pnpm trip:scrape           # browser scraper only, headless
pnpm trip:scrape:headed    # browser scraper with a visible persistent profile
```

The headed command is useful if Wanderlog later requires authentication. Browser state is retained under the gitignored `private-import/browser-profile` directory.

Optional source-keyed corrections are automatically loaded from `private-import/overrides.yaml` when present.

The lower-level file importer remains available for debugging:

```bash
pnpm trip:import private-import/wanderlog-trip.json
pnpm trip:import private-import/wanderlog-page.html
```

Run static checks with:

```bash
pnpm typecheck
pnpm test
```

Raw Wanderlog files, browser profiles, overrides, and import reports remain private and excluded from Git. The generated `TripBundle` is the only application data contract.

See [docs/project-spec.md](docs/project-spec.md) for the product specification and [docs/ingestion.md](docs/ingestion.md) for the ingestion implementation.
