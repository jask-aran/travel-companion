# Travel Companion

A fast, mobile-first PWA for viewing a shared trip itinerary.

The operator pipeline is local and semi-deterministic:

```text
Wanderlog API (primary)  ─┐
                          ├─→ normaliser → TripBundle (gitignored) → local PWA build
Playwright HTML fallback ─┘
```

Raw Wanderlog output never belongs in git. The Wanderlog trip id lives only in a gitignored local config. How the live site is served, and how a phone can refresh it, is in [docs/hosting.md](docs/hosting.md).

Production photos persist in the private R2 bucket `travel-companian`, bound as `PHOTOS`. See [photo storage](docs/hosting.md#photo-storage).

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium   # backup scraper only

cp config/trip.example.yaml config/trip.local.yaml
# edit trip.local.yaml: wanderlogId, publicId, wanderlog.web.url, paths.workingBundle
```

The pull is a plain `GET https://wanderlog.com/api/tripPlans/<wanderlogId>?clientSchemaVersion=2`, the same call the Pages refresh function makes. No login is needed: the plan-URL key is the credential, so treat it as a secret.

`wanderlog-cli` is no longer needed for a pull. See [When to use wanderlog-cli](docs/ingestion.md#when-to-use-wanderlog-cli) for editing the trip and other account work.

## Operator loop

```bash
pnpm trip:refresh    # API first, HTML scraper on API failure
pnpm dev             # serves the generated working.json as /trip.json
```

Forced sources:

```bash
pnpm trip:pull             # API only
pnpm trip:pull:cli         # wanderlog-cli only
pnpm trip:scrape           # browser scraper only, headless
pnpm trip:scrape:headed    # visible browser (auth if needed)
```

`trip:refresh` reads **`config/trip.local.yaml`** (gitignored). It:

1. fetches the trip JSON from the Wanderlog API;
2. validates and saves raw JSON under `private-import/` (gitignored);
3. falls back to Playwright when API acquisition fails;
4. normalises through the shared allow-listed pipeline;
5. writes `public-data/trips/<publicId>/working.json` (gitignored) plus private reports.

Viewing the itinerary never talks to Wanderlog. Vite serves that local `working.json` as `/trip.json` in dev and embeds it into `dist/` on `pnpm build`. The production refresh button asks the Pages function to pull Wanderlog. See [docs/hosting.md](docs/hosting.md).

```bash
pnpm build
pnpm preview
```

Build fails closed if you have not refreshed a local bundle yet.

## Checks

```bash
pnpm typecheck
pnpm test
```

## What is private

| Path | Role |
|------|------|
| `config/trip.local.yaml` | Wanderlog trip id, plan URL, local paths |
| `private-import/` | Raw trip JSON, scraped HTML, browser profile, overrides, reports |
| `public-data/**/working.json` | Normalised TripBundle used by the PWA |
| `apps/web/dist/` | Local build output (may contain the bundle) |

Committed: `config/trip.example.yaml` (placeholders only), schema, normaliser, PWA shell.

## Repository layout

```text
apps/web                 SolidJS itinerary PWA
packages/trip-schema     Canonical TripBundle schema
packages/trip-normaliser Wanderlog → TripBundle
packages/wanderlog-import API/CLI/HTML acquisition adapters
config/trip.example.yaml Template for local config
config/trip.local.yaml   Your trip id (gitignored)
docs/                    Product spec, ingestion, and hosting
workers/refresh          Pages function: serve trip.enc from KV, refresh from Wanderlog
```

## Tracking

1. [Ingestion and schema](https://github.com/jask-aran/travel-companion/issues/1) (done)
2. [Continuous itinerary PWA](https://github.com/jask-aran/travel-companion/issues/2) (done)
3. [Map interaction](https://github.com/jask-aran/travel-companion/issues/3)
4. [Publishing and updates](https://github.com/jask-aran/travel-companion/issues/4)
5. [Optional live-editing backend](https://github.com/jask-aran/travel-companion/issues/5)

See [docs/project-spec.md](docs/project-spec.md) and [docs/ingestion.md](docs/ingestion.md).
