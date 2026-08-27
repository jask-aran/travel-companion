# Travel Companion

A fast, mobile-first PWA for viewing a shared trip itinerary.

The operator pipeline is local and semi-deterministic:

```text
Wanderlog CLI (primary)  ─┐
                          ├─→ normaliser → TripBundle (gitignored) → local PWA build
Playwright HTML fallback ─┘
```

Raw Wanderlog output never belongs in git. The Wanderlog trip id lives only in a gitignored local config. Hosting/sharing privacy is deferred until you actually need to publish.

## One-time setup

```bash
pnpm install
pnpm exec playwright install chromium   # backup scraper only

cp config/trip.example.yaml config/trip.local.yaml
# edit trip.local.yaml: wanderlogId, publicId, wanderlog.web.url, paths.workingBundle
```

CLI notes:

- Use **`wanderlog trips show <id> --output json`** (modern subcommand).
- Do **not** use the legacy `wanderlog trip` singular alias — it mishandles flags.
- Scripts spawn the binary directly, so shell aliases are ignored. Set `wanderlog.cli.command` in `trip.local.yaml` to the real binary name on your PATH (often `wanderlog-cli` if installed from Go).
- Read-only export of a shared trip can work without login.

## Operator loop

```bash
pnpm trip:refresh    # CLI first, HTML scraper on CLI failure
pnpm dev             # serves the generated working.json as /trip.json
```

Forced sources:

```bash
pnpm trip:pull             # CLI only
pnpm trip:scrape           # browser scraper only, headless
pnpm trip:scrape:headed    # visible browser (auth if needed)
```

`trip:refresh` reads **`config/trip.local.yaml`** (gitignored). It:

1. runs `wanderlog-cli trips show <configured-id> --output json`;
2. validates and saves raw JSON under `private-import/` (gitignored);
3. falls back to Playwright when CLI acquisition fails;
4. normalises through the shared allow-listed pipeline;
5. writes `public-data/trips/<publicId>/working.json` (gitignored) plus private reports.

The web app never talks to Wanderlog. Vite serves that local `working.json` as `/trip.json` in dev and embeds it into `dist/` on `pnpm build`.

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
| `private-import/` | Raw CLI JSON, scraped HTML, browser profile, overrides, reports |
| `public-data/**/working.json` | Normalised TripBundle used by the PWA |
| `apps/web/dist/` | Local build output (may contain the bundle) |

Committed: `config/trip.example.yaml` (placeholders only), schema, normaliser, PWA shell.

## Repository layout

```text
apps/web                 SolidJS itinerary PWA
packages/trip-schema     Canonical TripBundle schema
packages/trip-normaliser Wanderlog → TripBundle
packages/wanderlog-import CLI/HTML acquisition adapters
config/trip.example.yaml Template for local config
config/trip.local.yaml   Your trip id (gitignored)
docs/                    Product spec and ingestion notes
```

## Tracking

1. [Ingestion and schema](https://github.com/jask-aran/travel-companion/issues/1) (done)
2. [Continuous itinerary PWA](https://github.com/jask-aran/travel-companion/issues/2) (done)
3. [Map interaction](https://github.com/jask-aran/travel-companion/issues/3)
4. [Publishing and updates](https://github.com/jask-aran/travel-companion/issues/4)
5. [Optional live-editing backend](https://github.com/jask-aran/travel-companion/issues/5)

See [docs/project-spec.md](docs/project-spec.md) and [docs/ingestion.md](docs/ingestion.md).
