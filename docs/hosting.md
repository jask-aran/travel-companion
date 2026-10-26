# How the app is hosted

The live site is a static PWA on Cloudflare Pages, with one Pages Function in front of it. There is no separate Cloudflare Worker service. The function in the visitor's browser is a different thing: a service worker that caches the shell.

Production URL: `https://trips.jask-aran.com/japankorea2026/`. Pages project: `jask-aran`.

## Photo storage

Place photos persist in the private R2 bucket `travel-companian` (the spelling is the bucket's real name), bound as `PHOTOS`: Standard storage in OC, public `r2.dev` access disabled, no custom domain. All 91 photos of the trip were stored on 2026-10-26; after that a photo costs a Google request only for a place not seen before. Check it with a request to `api/photo`: `x-media-cache: r2-hit` means it came from R2, `r2-miss` that it was fetched and saved just now, and a missing or wrong token gets `401`.

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

The last step matters. The function serves the KV copy whenever one exists, so after a phone refresh a ship that only uploaded the static `trip.enc` would never be seen. Writing KV too makes the ship's payload, with fresh photo names, the live one.

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

Place photos use the private R2 bucket `travel-companian`, bound as `PHOTOS`. The bucket already exists. Keep public bucket access disabled. The worker checks the trip token, serves a saved photo when present, or downloads and stores the photo on its first successful request. Objects have no application expiry; browser copies last 30 days. Images remain accessible to the Cloudflare account owner and are not encrypted with the trip passphrase.

The object key includes the public trip ID, image width, and Google Place ID. A new Google photo reference therefore reuses the saved image. To replace a saved image, delete its object and let the next request fetch the current reference; an existing browser copy can remain for 30 days. An expired reference cannot populate a missing object until a local pull obtains a fresh reference. Static maps retain the one-day edge cache. `pnpm dev` forwards photos and maps to the live worker (`TRIP_ORIGIN` overrides it), so development reads the same saved photos and never calls Google itself. This persistent photo storage is a deliberate personal-use choice outside Google's standard caching terms.

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

This path does not run `wanderlog-cli`, Playwright, or Vite. It does not call Google. Photo names are carried forward so a refresh stays inside the Workers subrequest limit. Use a local `pnpm trip:pull` to obtain fresh photo names, then `pnpm ship` to publish them; `ship` itself does not fetch photo names. Saved R2 images remain usable when their old Google photo reference expires.

Departure boards (train and bus times for flight transfers and timed journeys) are carried forward the same way, for every leg that still exists. They are fetched only by a local pull: Google Routes for Korea, NAVITIME (via RapidAPI, key in `config/trip.local.yaml` under `navitime.apiKey`) for Japan, since Google's API has no Japanese transit. NAVITIME's plan allows 500 requests a month, so answers are cached for a week in `public-data/trips/<trip>/departures-cache.json`.

**From the laptop.** `pnpm ship` rebuilds the shell, encrypts `working.json` into the static `trip.enc`, and uploads a new Pages deployment. Use that when the app itself changed, or when photo names need a fresh Google fetch. `pnpm trip:pull` and `pnpm trip:refresh` only update the local bundle. They do not touch the live site.

## Encryption

`apps/web/src/lib/trip-crypto.ts` is shared by the build, the browser, and the Pages function. AES-GCM, key from PBKDF2-SHA256. The iteration count is stored in the file, so an old payload still opens after the count changes.

New files use 100,000 iterations. Workers Web Crypto rejects anything above that, and the remote refresh has to decrypt the previous file to copy photo names. A local build used to write 310,000. Those files still decrypt on the phone. The function cannot read them, so a refresh after one of those ships will not copy photos.

## Secrets

Set on the Pages project, not in git:

| Secret | Used for |
|--------|----------|
| `WANDERLOG_TRIP_ID` | The plan-URL key. This is the edit key, not a view-only share link. |
| `TRIP_PASSPHRASE` | Encrypt the new payload, and check the refresh request. |

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
