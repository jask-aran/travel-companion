# Ingestion architecture

## Supported inputs

The importer accepts exactly two source formats:

1. JSON emitted by `wanderlog trips show <trip-id> --output json`.
2. Wanderlog HTML containing `window.__MOBX_STATE__.tripPlanStore.data`.

Both adapters converge on the same in-memory source object before normalisation. There is no Markdown adapter and no runtime dependency on Wanderlog.

## Command

```bash
pnpm trip:import <input> [--output path] [--overrides path] [--report path]
```

Example:

```bash
wanderlog trips show kdglzjrygigglbfo \
  --output json \
  > private-import/wanderlog-trip.json

pnpm trip:import private-import/wanderlog-trip.json \
  --overrides private-import/overrides.yaml
```

## Pipeline

```text
source detection
→ CLI JSON parse or embedded MobX extraction
→ shared Wanderlog source object
→ allow-listed normalisation
→ source-keyed overrides
→ Valibot TripBundle validation
→ working bundle + private reports
```

The HTML extractor scans from the MobX assignment to the end of the balanced JSON object while respecting JSON string escaping. It does not use DOM selectors or a regular expression to capture nested JSON.

## Output

The default working bundle is written to:

```text
public-data/trips/<trip-id>/<source-name>.working.json
```

Reports are written beside the private input:

```text
private-import/import-report.json
private-import/import-report.md
```

The report includes source fingerprint, imported counts, representative-image coverage, route coverage, redactions, and warnings.

## Overrides

Overrides use stable Wanderlog block IDs or Google Place IDs:

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

The normaliser constructs a new `TripBundle`; it never forwards the raw Wanderlog object. The current allow-list excludes account and contributor identifiers, confirmation numbers, reservation attachments, reviews, full photo collections, phone numbers, websites, address-component trees, currency tables, and browser state.

Raw files and reports remain under `private-import/`, which is ignored by Git.

## Images

The normaliser selects a single representative image per place:

1. explicit override URL;
2. first resolved `place.photo_urls` entry from the CLI response;
3. first Wanderlog `imageKeys` value retained as an unresolved source key;
4. no image, with a report warning.

The application should not receive full photo arrays. Resolving raw image keys into durable hosted assets remains a separate publishing concern.

## Routes

Cached routes are read from `resources.distancesBetweenPlaces`. A route is retained only when both Google Place IDs match imported places. The canonical route keeps travel mode, distance, duration, and encoded polyline.

## Validation and testing

```bash
pnpm typecheck
pnpm test
```

Tests cover CLI JSON parsing, nested MobX extraction, allow-listed normalisation, routes, representative images, and source-keyed overrides.
