# Travel Companion

A phone-first web app that shows one shared trip itinerary, built from a [Wanderlog](https://wanderlog.com) plan. Travellers open a link, type a passphrase once, and can install it and read it offline. Their own chat agent (Claude, ChatGPT) can read the trip too.

## Start

You need Node 22+, pnpm, and the id from your plan's URL (`wanderlog.com/plan/<id>/…`). Treat that id as a secret: it lets anyone read and edit the plan.

```bash
pnpm install
pnpm trip:init
```

The wizard:

1. Asks for the plan id (or the whole URL) and three optional keys, and tests the keys.
2. Pulls the trip, builds the site, and prints the passphrase your travellers type once on each phone.
3. Offers a menu:
   - preview the site on this computer
   - run the connector on this computer, for a chat agent there
   - put the site and connector online
   - put only the connector online
   - test or change the keys

Putting it online uses Cloudflare's free plan. The wizard logs you in (browser, or a pasted API token), asks for a name, a path and an optional custom domain, shows what it will create, and creates nothing until you agree. After that the site pulls plan changes from Wanderlog by itself.

Everything it asks is saved in `config/trip.local.yaml`, which is not committed. `config/trip.example.yaml` lists every setting.

### Optional keys

All three are used only once the site is on Cloudflare. Add or change them any time with `pnpm trip:keys`, which tests them and updates Cloudflare too.

| Key | Adds | Where to get it |
|---|---|---|
| Google Maps key | Place photos, street maps, transit times outside Japan | A Google Cloud API key on a project with billing on and Places API (New), Maps Static API, Routes API and Cloud Translation API enabled |
| Google project number | Better English names for lines and towns | The same project's number, on the Cloud console dashboard |
| NAVITIME key | Transit times in Japan | Your RapidAPI key, subscribed to NAVITIME's route API (`navitime-route-totalnavi`) |

Google is asked once per photo or map, and the answer is kept, so a trip costs a few hundred requests in total. The site also stops itself at 300 Google requests a day and stops asking for an hour after a refusal. Set daily quotas in the Google Cloud console as well: they are the only hard limit.

## How it works

1. **Pull.** `pnpm trip:pull` downloads the plan from Wanderlog and reduces it to one file, the `TripBundle` (`public-data/trips/<id>/working.json`): days, stops, stays, flights, booking references and routes between stops. It asks only Wanderlog.
2. **Build.** `pnpm build` writes a static site to `apps/web/dist/`. The trip is in it as `trip.enc`, encrypted with the passphrase and decrypted in the browser, so the site can sit on any public host.
3. **Host.** Either copy `apps/web/dist/` to any static host, or use Cloudflare Pages, which adds a small server function (`workers/refresh`). On Pages the function keeps the trip in KV and pulls it itself; until its first pull it serves the build's `trip.enc`. After setup the laptop is not needed for trip changes, and a deploy only replaces the app.

The Cloudflare function adds what a static host cannot:

- **Fresh trips.** It pulls Wanderlog itself when someone presses the refresh button, and when the trip is read after an idle hour. No rebuild is needed for a plan edit.
- **Photos and maps**, fetched from Google once and kept in an R2 bucket.
- **Live departure times** for today and tomorrow.
- **The connector.** "Copy connector link" in the app's footer gives a traveller an address to paste into Claude or ChatGPT as a custom connector. The link is the secret: whoever has it can read the whole trip.

## Commands

| Command | Does |
|---|---|
| `pnpm trip:init` | The wizard: set up, or come back to its menu |
| `pnpm trip:keys` | Test the keys; change them here and on Cloudflare (then redeploys) |
| `pnpm trip:pull` | Download the plan again |
| `pnpm dev` | Run the site locally (no passphrase) |
| `pnpm mcp` | Local connector at `http://127.0.0.1:4190/mcp`, for agents on this computer |
| `pnpm build` | Build the static site |
| `pnpm ship` | Deploy the app and function to Cloudflare (only the function for a connector-only setup); the live trip is left alone |
| `pnpm ship:dry` | Build and stage a deploy, upload nothing |
| `pnpm ship:check` | Check the online site works, with Google's and NAVITIME's request counts and last refusal; run it when photos or times stop loading |
| `pnpm typecheck`, `pnpm test` | Checks |

## Layout

```text
apps/web                 the app (SolidJS)
workers/refresh          the Cloudflare Pages function, including the connector
packages/trip-schema     the TripBundle shape
packages/trip-normaliser Wanderlog plan → TripBundle
packages/trip-brief      TripBundle → text for chat agents
packages/wanderlog-import downloading the plan, reading the config
data/trips/<id>          timetables copied by hand, for services the APIs lack
scripts                  the wizard, pull, deploy and local connector
```

MIT licensed.
