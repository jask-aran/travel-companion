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
- API, CLI and scraper timeouts, and the CLI command name
- persistent browser-profile directory
- raw-source, override, working-bundle, and report paths

`trip.local.yaml` and the legacy name `trip.yaml` are gitignored. Only `config/trip.example.yaml` (placeholders) is tracked.

## Acquisition order

`trip:refresh` uses automatic source selection:

```text
configured Wanderlog trip ID (from trip.local.yaml)
→ GET https://wanderlog.com/api/tripPlans/<id>?clientSchemaVersion=2
→ validate trip JSON
→ browser scraper on API failure
→ validate scraped MobX state
→ shared normaliser
→ TripBundle + reports
```

The API call needs no login. The plan-URL key is enough for Wanderlog to return the full trip, flights and confirmation numbers included, so treat it as a bearer token. The Pages refresh function makes the same call (see [hosting.md](hosting.md)), so a local pull and a phone refresh read one source.

The body is parsed and validated before the previous raw export is replaced. A non-2xx status, timeout (`wanderlog.api.timeoutMs`, default 60 s), or malformed response triggers the browser fallback.

Forced modes:

```bash
pnpm trip:pull             # API only
pnpm trip:pull:cli         # wanderlog-cli only
pnpm trip:scrape           # browser only, headless
pnpm trip:scrape:headed    # browser with visible persistent profile
```

## When to use wanderlog-cli

[`wanderlog-cli`](https://github.com/denysvitali/wanderlog-cli) wraps the same web API and covers far more of it: logging in, listing your trips and invites, and changing a trip. Reach for it when the project needs to write to Wanderlog or act as your account, not just read one plan. Reading does not need it.

Its read output is not byte-for-byte the API response. Measured against one trip (2026-10-21):

- It re-encodes through Go structs, so it writes empty values for fields it models (`confirmationNumber: ""` on most blocks) and drops fields it does not (`endTime`, `emailId`, `guests`, cancellation policy, place website, phone and ratings).
- Object keys come out sorted, which reorders `distancesBetweenPlaces` and so each day's `routeLegIds`.
- A few place visit-time estimates and opening hours differed from the API's. Two API calls a minute apart agreed, so this looks CLI-side, but the cause was not traced.
- Speed is the same. Both take about 3 s, nearly all of it Wanderlog's server time.

The normalised bundle was otherwise identical, so `trip:pull:cli` still works as a fallback. To use it:

```text
<wanderlog.cli.command> trips show <trip.wanderlogId> --output json
```

- Executed **without a shell**. Shell aliases (e.g. `alias wanderlog=wanderlog-cli`) are **not** visible to `spawn`, so set the real binary name in `wanderlog.cli.command` and keep it on `PATH`. The default is `wanderlog-cli`.
- Do **not** use the legacy singular `trip` subcommand. It mishandles flags.
- `trips show` does not authenticate. Listing trips and any edit do, via the CLI's own login.

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
API / CLI JSON ───┐
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

Successful API or CLI acquisition writes:

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

Unit tests use synthetic fixtures only — never real trip exports. Next test expansion: mock fetch, child-process and Playwright acquisition (API fail → browser fallback, timeouts, atomic writes) without contacting Wanderlog.
