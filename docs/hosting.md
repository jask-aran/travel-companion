# How the app is hosted

The live site is a static PWA on Cloudflare Pages, with one Pages Function in front of it. There is no separate Cloudflare Worker service. The function in the visitor's browser is a different thing: a service worker that caches the shell.

Production URL: `https://trips.jask-aran.com/japankorea2026/`. Pages project: `jask-aran`.

## Photo and map storage

Place photos and street maps persist in the private R2 bucket `travel-companian` (the spelling is the bucket's real name), bound as `MEDIA`: Standard storage in OC, public `r2.dev` access disabled, no custom domain. Each is fetched from Google once, the first time anyone opens it, and never again; all 91 photos of this trip were stored on 2026-10-26. Check it with a request to `api/photo` or `api/map`: `x-media-cache: r2-hit` means it came from R2, `r2-miss` that it was fetched and saved just now, and a missing or wrong token gets `401`.

Departure boards are not stored this way: they belong to a date and time, so they are fetched live (below).

## What the browser loads

`apps/web` is a SolidJS app. It does not know Wanderlog's schema and does not call Wanderlog while you read the itinerary. It fetches one file, decrypts it, and renders a `TripBundle`.

| Mode | Trip file | Passphrase |
|------|-----------|------------|
| `pnpm dev` | Vite serves `working.json` as `/trip.json` | Not used. Dev is plaintext. |
| Production | `trip.enc` | Required. Decryption happens in the browser. |

The passphrase is not in the JavaScript bundle. Reading the trip does not send it anywhere. The production refresh button does send it, once, over HTTPS. See below.

Vite's `base` is `/japankorea2026/`. Pages serves an upload at the site root, so `scripts/publish.ts` copies `apps/web/dist/` into `apps/web/.publish/japankorea2026/` before upload. Without that nest, every asset 404s.

## Pages and the function

`pnpm ship` builds the PWA, bundles `workers/refresh/index.ts` to `apps/web/.publish/_worker.js`, and runs:

```bash
wrangler pages deploy apps/web/.publish --project-name jask-aran --branch main --commit-dirty
wrangler kv key put trip.enc --path apps/web/dist/trip.enc --binding TRIP --remote
```

The last step matters. The function serves the KV copy whenever one exists, so after a phone refresh a ship that only uploaded the static `trip.enc` would never be seen. Writing KV too makes the ship's payload, with its departure boards and any new places' photo names, the live one.

Wrangler is a dev dependency. `cf pages deploy` does not upload this project. Its help text says the directory is not deployed by `cf`.

`_worker.js` is Pages advanced mode. That function receives every request for the hostname. It must forward anything it does not handle itself:

```text
GET or HEAD …/trip.enc     → KV key trip.enc, if present
                             else env.ASSETS (the file from the last ship)
POST …/api/refresh         → pull Wanderlog, encrypt, write KV
anything else              → env.ASSETS.fetch(request)
```

`env.ASSETS` is the static deployment: HTML, JS, CSS, fonts, icons, and the service worker. If the function stops calling it, the site breaks. A thrown error on a GET falls through to assets, so a KV fault does not take the shell down.

Bindings live in `wrangler.jsonc`. The trip store is the KV namespace bound as `TRIP`. The encrypted file is under 1 MB, which fits in KV.

Photos and maps use the R2 bucket bound as `MEDIA`. Keep public bucket access disabled. The worker checks the trip token, serves a saved image when present, or downloads and stores it on its first successful request. Objects have no application expiry; browser copies last 30 days. Images remain accessible to the Cloudflare account owner and are not encrypted with the trip passphrase.

A photo's key is the public trip ID, image width, and Google place ID (`<trip>/photos/480/<place>`), so a place keeps its image whatever photo name the trip carries. A pull keeps the photo name a place already has and asks Google only about new places; if that name has expired by the time the place is first opened, the worker asks for the current one (Place Details IDs Only, free). A map's key is its point and a hash of how it is drawn (`<trip>/maps/<lat,lng>/<hash>`), so changing its size or style draws new ones. To replace a saved image, delete its object; an existing browser copy can remain for 30 days. `pnpm dev` forwards photos and maps to the live worker (`TRIP_ORIGIN` overrides it), so development reads the same saved images and never calls Google itself. This persistent storage is a deliberate personal-use choice outside Google's standard caching terms.

## Two ways to update the trip

A Wanderlog edit does not require a new app shell. Only `trip.enc` changes.

**From the phone.** The footer button "Update from Wanderlog" is compiled into production builds only. It `POST`s to `/japankorea2026/api/refresh` with `Authorization: Bearer <trip passphrase>`. The function compares that header to the `TRIP_PASSPHRASE` secret. A wrong passphrase gets 401. The comparison does not stop at the first differing byte.

The function then:

1. `GET https://wanderlog.com/api/tripPlans/<WANDERLOG_TRIP_ID>?clientSchemaVersion=2`
2. runs the same normaliser as a local pull (`packages/trip-normaliser`)
3. copies Google photo names off the previous KV payload, if it can decrypt it
4. compares the result with the previous payload, ignoring `revision` and `generatedAt`. If nothing else differs, it writes nothing and returns `changed: false`
5. otherwise encrypts the new bundle and writes KV key `trip.enc`
6. returns counts only, not the trip

On `changed: false` the button says "Already up to date." and does nothing else. Otherwise it deletes the browser cache named `trip-bundle` and reloads. `revision` hashes the raw Wanderlog response, which can change without a real edit, so it is not used for the check. If the previous payload cannot be decrypted (a 310,000-iteration file), the refresh always writes.

This path does not run `wanderlog-cli`, Playwright, or Vite. It does not call Google. Photo names are carried forward so a refresh stays inside the Workers subrequest limit. A place added on the phone has no photo until a local `pnpm trip:pull` and `pnpm ship`; `ship` itself does not fetch photo names.

Departure boards (train and bus times for flight transfers and timed journeys) are carried forward the same way, for every leg that still exists. A local pull fetches them for every leg: Google Routes for Korea, NAVITIME (via RapidAPI, key in `config/trip.local.yaml` under `navitime.apiKey`) for Japan, since Google's API has no Japanese transit, with curated timetables from `data/trips/<trip>/` replacing NAVITIME's estimates where they match. NAVITIME's plan allows 500 requests a month, so a pull's answers are cached for a week in `public-data/trips/<trip>/departures-cache.json`.

Over those, the app asks the function live (`api/departures`, `workers/refresh/live-boards.ts`) for today's and tomorrow's legs, where each leg starts, and for any later leg whose pulled board is missing or was fetched for another time (a stop added or moved on the phone). The question carries the two places and the target time, not the trip. The function builds the board as a pull does, with the curated timetables inlined into the worker bundle, and keeps it in KV under `boards/<hash of the question>`: everyone gets that copy until it is 12 hours old (a week for later days). A failed or unaskable request keeps nothing and serves the old copy, if any. Translations of line and station names are kept in KV under `translations`. Live NAVITIME requests stop at 300 a calendar month (`navitime/<YYYY-MM>`), leaving the rest for pulls. The service worker keeps the last answer for offline use, and without one the pulled board stands.

**From the laptop.** `pnpm ship` rebuilds the shell, encrypts `working.json` into the static `trip.enc`, and uploads a new Pages deployment. Use that when the app itself changed, or after a pull. `pnpm trip:pull` and `pnpm trip:refresh` only update the local bundle. They do not touch the live site.

## Encryption

`apps/web/src/lib/trip-crypto.ts` is shared by the build, the browser, and the Pages function. AES-GCM, key from PBKDF2-SHA256. The iteration count is stored in the file, so an old payload still opens after the count changes.

New files use 100,000 iterations. Workers Web Crypto rejects anything above that, and the remote refresh has to decrypt the previous file to copy photo names. A local build used to write 310,000. Those files still decrypt on the phone. The function cannot read them, so a refresh after one of those ships will not copy photos.

## Secrets

Set on the Pages project, not in git:

| Secret | Used for |
|--------|----------|
| `WANDERLOG_TRIP_ID` | The plan-URL key. This is the edit key, not a view-only share link. |
| `TRIP_PASSPHRASE` | Encrypt the new payload, and check the refresh request and the photo, map and board token. |
| `GOOGLE_MAPS_API_KEY` | Photos, maps, Google Routes boards and name translation. |
| `NAVITIME_API_KEY` | NAVITIME boards (the RapidAPI key, `navitime.apiKey` locally). |
| `GOOGLE_PROJECT_NUMBER` | Selects the Translation LLM for names (`google.projectNumber` locally). |

`PUBLIC_ID` is a plain var in `wrangler.jsonc` (`japan-korea-2026`). It becomes `TripBundle.tripId`. It is not a secret.

The plan-URL key is enough for Wanderlog to return the full trip, including flights and confirmation numbers, with no login. `wanderlog trips show` does not authenticate. Listing trips does. Treat the plan URL as a bearer token.

## The browser service worker

`vite-plugin-pwa` generates a service worker in the visitor's browser. It is not the Pages function.

It precaches the shell (JS, CSS, fonts) and deliberately does not precache `trip.enc`. A trip edit would otherwise force a full app update before new data could show. `trip.enc` uses stale-while-revalidate, cache name `trip-bundle`. That is why a refresh deletes that cache before reload. An already-installed app may show the old shell until that service worker updates. Reload once after `pnpm ship`.

## What stays local

| Path | Role |
|------|------|
| `config/trip.local.yaml` | Trip id, passphrase, Google browser key, paths. Gitignored. |
| `private-import/wanderlog-trip.json` | Raw Wanderlog export. Gitignored. |
| `public-data/trips/japan-korea-2026/working.json` | Normalised bundle the local build encrypts. Gitignored. |
| `apps/web/dist/trip.enc` | Ciphertext written at build time. |

The Google browser key ships inside the built app. Google forbids caching Place Photos, so the browser loads each image itself. Restrict the key by HTTP referrer. The Pages function does not use it.
