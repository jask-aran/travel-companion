# Ingestion architecture

## Operator command

The normal ingestion path is one command:

```bash
pnpm trip:refresh
```

## Local configuration (gitignored)

Trip identity is **not** committed. Copy the template and edit locally:

```bash
cp config/trip.example.yaml config/trip.local.yaml
```

`config/trip.local.yaml` defines:

- Wanderlog trip ID (from the plan URL)
- public trip slug (local output path + `TripBundle.tripId` only)
- canonical Wanderlog URL (scraper fallback)
- CLI command and timeouts
- persistent browser-profile directory
- raw-source, override, working-bundle, and report paths

`trip.local.yaml` and the legacy name `trip.yaml` are gitignored. Only `config/trip.example.yaml` (placeholders) is tracked.

## Acquisition order

`trip:refresh` uses automatic source selection:

```text
configured Wanderlog trip ID (from trip.local.yaml)
→ wanderlog-cli trips show <id> --output json
→ validate CLI JSON
→ browser scraper on CLI failure
→ validate scraped MobX state
→ shared normaliser
→ TripBundle + reports
```

The primary acquisition command is executed **without a shell**:

```text
<wanderlog.cli.command> trips show <trip.wanderlogId> --output json
```

Default command name is `wanderlog-cli`. Shell aliases (e.g. `alias wanderlog=wanderlog-cli`) are **not** visible to `spawn`, so set the real binary name in config and keep it on `PATH`.

Do **not** use the legacy singular `trip` subcommand — it mishandles flags. Always use `trips show … --output json`.

Stdout is captured directly, parsed, and validated before the previous raw export is replaced. A missing executable, timeout, non-zero exit code, or malformed response triggers the browser fallback.

Forced modes:

```bash
pnpm trip:pull             # CLI only
pnpm trip:scrape           # browser only, headless
pnpm trip:scrape:headed    # browser with visible persistent profile
```

## Browser scraper

Playwright Chromium loads the configured canonical Wanderlog URL and waits for:

```js
window.__MOBX_STATE__.tripPlanStore.data.tripPlan
```

It saves the complete page HTML and passes it to the embedded-state parser (balanced JSON scan, not regex over nested objects). It does not scrape rendered cards or CSS selectors. If embedded state moves, acquisition fails explicitly.

Profile directory:

```text
private-import/browser-profile/
```

Gitignored. Never copy into deployment artefacts.

## Shared source boundary

```text
CLI JSON ─────────┐
                  ├─> WanderlogSourceData ─> allow-listed normaliser
HTML/MobX state ──┘
```

No Markdown adapter. No separate HTML normaliser.

## Example local config shape

See `config/trip.example.yaml`. Shape:

```yaml
trip:
  wanderlogId: YOUR_WANDERLOG_TRIP_ID
  publicId: my-trip

wanderlog:
  cli:
    command: wanderlog-cli
    timeoutMs: 60000
  web:
    url: https://wanderlog.com/plan/YOUR_WANDERLOG_TRIP_ID/your-trip-slug
    browserProfileDir: private-import/browser-profile
    headless: true
    timeoutMs: 60000

paths:
  rawJson: private-import/wanderlog-trip.json
  rawHtml: private-import/wanderlog-page.html
  overrides: private-import/overrides.yaml
  workingBundle: public-data/trips/my-trip/working.json
  report: private-import/import-report.json
```

The Wanderlog ID controls acquisition. The public ID controls `TripBundle.tripId` and the working-bundle path only — the UI never needs the Wanderlog key.

## Installation

```bash
pnpm install
pnpm exec playwright install chromium
cp config/trip.example.yaml config/trip.local.yaml
# edit trip.local.yaml
```

## Raw and generated outputs

Successful CLI acquisition writes:

```text
private-import/wanderlog-trip.json
```

Successful browser acquisition writes:

```text
private-import/wanderlog-page.html
```

Both produce (paths from local config):

```text
public-data/trips/<publicId>/working.json
private-import/import-report.json
private-import/import-report.md
```

Writes use temp file + rename. All of the above are gitignored.

## PWA consumption

The web app does not embed trip content in git. Vite reads `paths.workingBundle` from `config/trip.local.yaml` and:

- serves it as `/trip.json` in `pnpm dev`
- copies it into `apps/web/dist/trip.json` on `pnpm build`

Build fails if the working bundle has not been generated yet.

## Manual file import

```bash
pnpm trip:import private-import/wanderlog-trip.json
pnpm trip:import private-import/wanderlog-page.html
```

Debug/tests only — does not acquire fresh data and does not read trip.local.yaml for acquisition.

## Overrides

`trip:refresh` loads `private-import/overrides.yaml` when present (path configurable). Source-keyed by Wanderlog block id or Google Place id. Do not hand-edit generated bundles.

## Privacy boundary

The normaliser constructs a new `TripBundle`; it never forwards the raw Wanderlog object. Allow-list excludes account/contributor identifiers, confirmation numbers, reservation attachments, reviews, full photo collections, phone numbers, websites, address-component trees, currency tables, and browser state.

## Images and routes

One representative image per place: override URL, first resolved Wanderlog photo URL, first Wanderlog image key, or none with a warning. Cached routes from `resources.distancesBetweenPlaces` only when both endpoints match imported Google Place IDs.

## Validation

```bash
pnpm typecheck
pnpm test
```

Unit tests use synthetic fixtures only — never real trip exports. Next test expansion: mock child-process and Playwright acquisition (CLI fail → browser fallback, timeouts, atomic writes) without contacting Wanderlog.
