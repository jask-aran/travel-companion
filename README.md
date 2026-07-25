# Travel Companion

A fast, mobile-first PWA for viewing a shared trip itinerary.

The app is centred on one continuous, vertically scrollable itinerary with sticky day navigation, representative place images, inline travel details, a floating half-height map, and direct Google Maps handoff for navigation.

Trip data is imported from Wanderlog using `wanderlog-cli` JSON, with saved-page MobX state extraction as a backup. Raw Wanderlog data is normalised into a privacy-safe, versioned `TripBundle` before publishing.

## Ingestion

Requirements: Node.js 22+, pnpm, and the Wanderlog CLI.

```bash
pnpm install
mkdir -p private-import
wanderlog trips show <trip-id> --output json > private-import/wanderlog-trip.json
pnpm trip:import private-import/wanderlog-trip.json
```

The command writes a validated working bundle under `public-data/trips/<trip-id>/` and private JSON/Markdown import reports beside the source file.

Saved HTML containing `window.__MOBX_STATE__` is accepted by the same command:

```bash
pnpm trip:import private-import/wanderlog-page.html
```

Optional source-keyed corrections can be applied with:

```bash
pnpm trip:import private-import/wanderlog-trip.json \
  --overrides private-import/overrides.yaml
```

Run static checks with:

```bash
pnpm typecheck
pnpm test
```

The initial application is read-only and statically hosted. Installed clients will receive itinerary updates through immutable trip revisions and a small manifest. A lightweight live-editing backend may be added later without changing the client data contract.

See [docs/project-spec.md](docs/project-spec.md) for the complete product specification and [docs/ingestion.md](docs/ingestion.md) for the implemented ingestion boundary.
