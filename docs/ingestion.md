# Ingestion architecture

## Operator command

The normal ingestion path is one command:

```bash
pnpm trip:refresh
```

Configuration lives in `config/trip.yaml`. It defines the Wanderlog trip ID, public trip ID, canonical Wanderlog URL, CLI command and timeouts, persistent browser-profile directory, raw-source paths, override path, working-bundle path, and report path.

## Acquisition order

`trip:refresh` uses automatic source selection:

```text
configured Wanderlog trip ID
→ wanderlog-cli
→ validate CLI JSON
→ browser scraper on CLI failure
→ validate scraped MobX state
→ shared normaliser
→ TripBundle + reports
```

The primary acquisition command is executed without a shell:

```text
wanderlog trips show <configured-trip-id> --output json
```

Stdout is captured directly, parsed, and validated before the previous raw export is replaced. A missing executable, timeout, non-zero exit code, or malformed response triggers the browser fallback.

Forced modes are available:

```bash
pnpm trip:pull
pnpm trip:scrape
pnpm trip:scrape:headed
```

`trip:pull` permits only CLI acquisition. `trip:scrape` permits only headless browser acquisition. `trip:scrape:headed` opens the persistent browser profile visibly so an organiser can authenticate if Wanderlog later requires it.

## Browser scraper

The scraper uses Playwright Chromium and the configured canonical Wanderlog URL. It waits for:

```js
window.__MOBX_STATE__.tripPlanStore.data.tripPlan
```

It then saves the complete page HTML and passes it to the existing embedded-state parser. The parser scans from the MobX assignment through a balanced JSON object while respecting quoted strings and escaping.

The backup does not scrape itinerary cards, query CSS classes, or reconstruct data from rendered text. If Wanderlog removes or relocates the embedded state, acquisition fails explicitly.

The persistent browser profile is stored under:

```text
private-import/browser-profile/
```

It is private, gitignored, and must not be copied into deployment artefacts.

## Shared source boundary

CLI JSON and scraped HTML converge before normalisation:

```text
CLI JSON ─────────┐
                  ├─> WanderlogSourceData ─> allow-listed normaliser
HTML/MobX state ──┘
```

There is no Markdown adapter and no separate HTML normaliser.

## Configuration

Current project configuration:

```yaml
trip:
  wanderlogId: kdglzjrygigglbfo
  publicId: japan-korea-2026

wanderlog:
  cli:
    command: wanderlog
    timeoutMs: 60000
  web:
    url: https://wanderlog.com/plan/kdglzjrygigglbfo/japankorea-trip
    browserProfileDir: private-import/browser-profile
    headless: true
    timeoutMs: 60000
```

The Wanderlog ID controls acquisition. The public ID controls the generated `TripBundle.tripId` and output path; the UI does not need to expose Wanderlog’s key.

## Installation

```bash
pnpm install
pnpm exec playwright install chromium
```

The second command installs the browser binary used by the backup scraper.

## Raw and generated outputs

Successful CLI acquisition writes:

```text
private-import/wanderlog-trip.json
```

Successful browser acquisition writes:

```text
private-import/wanderlog-page.html
```

Both produce:

```text
public-data/trips/japan-korea-2026/working.json
private-import/import-report.json
private-import/import-report.md
```

Writes use a temporary file followed by rename so a failed acquisition or normalisation does not leave a partially written source or bundle.

## Manual file import

The lower-level importer remains available for tests and debugging:

```bash
pnpm trip:import private-import/wanderlog-trip.json
pnpm trip:import private-import/wanderlog-page.html
```

It is not the normal operator workflow because it does not acquire fresh data.

## Overrides

`trip:refresh` automatically loads `private-import/overrides.yaml` when present.

```yaml
places:
  source-block:710309054:
    displayName: Takayama accommodation
    publishAddress: false
    imageUrl: https://example.test/approved-image.jpg

  google-place:ChIJExample:
    latitude: 36.1400
    longitude: 137.2500

items:
  source-block:123456:
    startTime: "09:00"
    status: tentative
    notes: Confirm the morning bus.
```

Generated bundles should not be edited manually.

## Privacy boundary

The normaliser constructs a new `TripBundle`; it never forwards the raw Wanderlog object. The allow-list excludes account and contributor identifiers, confirmation numbers, reservation attachments, reviews, full photo collections, phone numbers, websites, address-component trees, currency tables, and browser state.

Raw files, browser state, overrides, and reports remain under `private-import/`, which is ignored by Git.

## Images and routes

The normaliser selects one representative image per place: override URL, first resolved Wanderlog photo URL, first Wanderlog image key, or no image with a warning. It does not ship full source photo arrays.

Cached routes come from `resources.distancesBetweenPlaces`. A route is retained only when both endpoints match imported Google Place IDs. Travel mode, distance, duration, and encoded polyline are preserved.

## Validation

```bash
pnpm typecheck
pnpm test
```

Tests cover source parsing and normalisation. The next test expansion should mock child-process and Playwright acquisition so CLI failure, browser fallback, timeout, and atomic-write behaviour are covered without contacting Wanderlog.
