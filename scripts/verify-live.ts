import { parseTripBundle, type TripBundle } from "../packages/trip-schema/src/index.js";
import { decryptTrip, WrongPassphraseError, type EncryptedPayload } from "../apps/web/src/lib/trip-crypto.js";
import { AGENT_ROUTE, agentToken } from "../apps/web/src/lib/agent-link.js";
import { MEDIA_ROUTES, STATUS_ROUTE, mediaToken, photoPlaceId } from "../apps/web/src/lib/media.js";
import type { Provider, ProviderStatus } from "../workers/refresh/guard.js";

/**
 * Checks that a deployed site works, not just that it is up: the app, the
 * trip, the connector, the refresh route, photos and what Google and
 * NAVITIME last refused. Read-only apart from two
 * POSTs that the server must reject. Reasons never contain the passphrase, a
 * token or trip content.
 *
 * A right-token connector call and the trip read can each start the server's
 * idle refresh (a Wanderlog pull after an hour without one), exactly as a
 * traveller opening the app would.
 */

export type CheckStatus = "pass" | "fail" | "skipped";
export type Check = { name: string; status: CheckStatus; reason: string };

export type VerifyOptions = {
  /** Origin plus base, e.g. `https://trips.example/my-trip/`. */
  site: string;
  passphrase: string;
  /** A connector-only deployment: there is no app page or trip file to check. */
  connectorOnly?: boolean;
  mediaBucket: boolean;
  googleKey: boolean;
  navitimeKey?: boolean;
  /** Tests pass a fake; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
};

const TOOLS = ["get_overview", "get_bookings", "get_day", "get_trip"];

export async function verifyLive(options: VerifyOptions): Promise<Check[]> {
  const site = options.site.endsWith("/") ? options.site : `${options.site}/`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const get = (path: string, init: RequestInit = {}) =>
    doFetch(new URL(path, site).toString(), { ...init, cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, reason: string): void => {
    checks.push({ name, status, reason });
  };
  /** Runs one check; a network fault or timeout is its failure, not the run's. */
  const attempt = async (name: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      add(name, "fail", timedOut ? `No answer within ${timeoutMs / 1000}s.` : "Could not reach the site (network error).");
    }
  };
  const isHtml = (response: Response) => (response.headers.get("content-type") ?? "").includes("text/html");

  if (!options.connectorOnly) await attempt("App page", async () => {
    const page = await get("");
    if (page.status !== 200 || !isHtml(page)) {
      return add("App page", "fail", `The app page answered ${page.status}${isHtml(page) ? "" : " and is not HTML"}. Run \`pnpm ship\` again.`);
    }
    const manifest = await get("manifest.webmanifest");
    const worker = await get("sw.js");
    const missing = [
      ...(manifest.ok && !isHtml(manifest) ? [] : ["web manifest"]),
      ...(worker.ok && !isHtml(worker) ? [] : ["service worker"]),
    ];
    if (missing.length) return add("App page", "fail", `The page loads but its ${missing.join(" and ")} is missing, so it won't install or work offline. Run \`pnpm ship\`.`);
    add("App page", "pass", "Page, web manifest and service worker are served.");
  });

  // The connector first: whether it takes the local token tells the trip
  // check which explanation is likelier.
  let secret: "same" | "differs" | "missing" | "unknown" = "unknown";
  await attempt("Connector", async () => {
    const token = await agentToken(options.passphrase);
    const mcp = (path: string, body: unknown) => get(`${AGENT_ROUTE}/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(body),
    });
    const wrong = await mcp("0".repeat(64), { jsonrpc: "2.0", id: 1, method: "ping" });
    if (wrong.status === 503) {
      secret = "missing";
      return add("Connector", "fail", "The TRIP_PASSPHRASE secret is missing on the Pages project. Add it (Settings → Variables and Secrets) and ship again.");
    }
    if (wrong.status !== 401) {
      return add("Connector", "fail", `A wrong connector link got ${wrong.status}, not 401: the Pages function is probably not deployed. Run \`pnpm ship\`.`);
    }
    const list = await mcp(token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    if (list.status === 401) {
      secret = "differs";
      return add("Connector", "fail", "The connector refuses the link made from your local passphrase: the TRIP_PASSPHRASE secret on Cloudflare differs from config/trip.local.yaml. Set it to the same value.");
    }
    if (list.status === 429) return add("Connector", "fail", "The connector is rate-limiting requests. Wait a minute and run `pnpm ship:check` again.");
    secret = "same";
    const names = ((await list.json().catch(() => ({}))) as { result?: { tools?: { name?: string }[] } })
      .result?.tools?.map((tool) => tool.name) ?? [];
    if (list.status !== 200 || !TOOLS.every((name) => names.includes(name))) {
      return add("Connector", "fail", `The connector's tool list answered ${list.status} without the four trip tools. Run \`pnpm ship\`.`);
    }
    const call = await mcp(token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_overview", arguments: {} } });
    const result = ((await call.json().catch(() => ({}))) as { result?: { isError?: boolean; content?: { text?: string }[] } }).result;
    if (call.status !== 200 || result?.isError || !result?.content?.[0]?.text) {
      return add("Connector", "fail", `The connector lists its tools but get_overview failed (${call.status}): the server could not read the trip.`);
    }
    add("Connector", "pass", "Rejects a wrong link; the real link lists the four tools and answers get_overview.");
  });

  let bundle: TripBundle | undefined;
  if (!options.connectorOnly) await attempt("Trip", async () => {
    const response = await get("trip.enc");
    const text = response.ok ? await response.text() : "";
    let payload: EncryptedPayload | undefined;
    try {
      payload = text && !isHtml(response) ? JSON.parse(text) as EncryptedPayload : undefined;
    } catch {
      payload = undefined;
    }
    if (!payload?.data) {
      return add("Trip", "fail", `trip.enc is not there (${response.status}${isHtml(response) ? ", the app page instead" : ""}): the build had none and the server has not pulled one. Press refresh in the app.`);
    }
    try {
      bundle = parseTripBundle(JSON.parse(await decryptTrip(payload, options.passphrase)));
    } catch (error) {
      if (!(error instanceof WrongPassphraseError)) {
        return add("Trip", "fail", "trip.enc decrypts but is not a valid trip: press refresh in the app to pull it again.");
      }
      const why = secret === "differs"
        ? "the TRIP_PASSPHRASE secret on Cloudflare differs from your local one, and a refresh re-encrypted the trip with it. Set the secret to your local passphrase, then press refresh in the app."
        : secret === "same"
          ? "it was written with an older passphrase (the server's secret matches yours). Press refresh in the app to pull it again."
          : "the TRIP_PASSPHRASE secret on Cloudflare most likely differs from your local one. Set it to the same value, then press refresh in the app.";
      return add("Trip", "fail", `trip.enc does not open with your local passphrase: ${why}`);
    }
    add("Trip", "pass", "trip.enc is served and opens with your local passphrase.");
  });

  await attempt("Refresh route", async () => {
    const response = await get("api/refresh", { method: "POST", headers: { authorization: "Bearer wrong" } });
    if (response.status === 401) return add("Refresh route", "pass", "Exists and rejects a wrong passphrase.");
    if (response.status === 503) {
      return add("Refresh route", "fail", "The refresh button is not set up: the WANDERLOG_TRIP_ID or TRIP_PASSPHRASE setting is missing on the Pages project.");
    }
    add("Refresh route", "fail", `A wrong passphrase got ${response.status}, not 401: the Pages function is probably not deployed. Run \`pnpm ship\`.`);
  });

  if (!options.mediaBucket || !options.googleKey) {
    const missing = [...(options.mediaBucket ? [] : ["cloudflare.mediaBucket"]), ...(options.googleKey ? [] : ["google.apiKey"])];
    add("Photos", "skipped", `Not configured (${missing.join(" and ")} not set).`);
  } else if (!bundle) {
    add("Photos", "skipped", "The trip did not open, so there is no place to ask a photo for.");
  } else {
    // As the app asks: by the Google place of a place the trip names a photo for.
    const named = Object.values(bundle.places).find((place) => place.photo?.name && photoPlaceId(place));
    const place = named && photoPlaceId(named);
    if (!place) {
      add("Photos", "skipped", "No place in the trip has a photo yet.");
    } else {
      await attempt("Photos", async () => {
        const query = new URLSearchParams({ place, t: await mediaToken(options.passphrase) });
        const response = await get(`${MEDIA_ROUTES.photo}?${query.toString()}`);
        const type = response.headers.get("content-type") ?? "";
        await response.body?.cancel();
        if (response.ok && type.startsWith("image/")) return add("Photos", "pass", "A place photo comes back as an image.");
        if (response.status === 503) {
          return add("Photos", "fail", "Photos are off on the server: the GOOGLE_MAPS_API_KEY secret, the TRIP_PASSPHRASE secret or the MEDIA bucket binding is missing on the Pages project.");
        }
        if (response.status === 401) return add("Photos", "fail", "The server refused the photo token: its TRIP_PASSPHRASE secret differs from your local passphrase.");
        add("Photos", "fail", `A place photo answered ${response.status}${type ? ` (${type.split(";")[0]})` : ""}: check the Google key's Places API access and billing.`);
      });
    }
  }

  // What the server's guard has counted and been refused: where a provider's error shows up.
  const wanted: [Provider, string, boolean][] = [["google", "Google", options.googleKey], ["navitime", "NAVITIME", Boolean(options.navitimeKey)]];
  let statuses: Record<Provider, ProviderStatus> | undefined;
  if (wanted.some(([, , has]) => has)) {
    try {
      const response = await get(`${STATUS_ROUTE}?t=${await mediaToken(options.passphrase)}`);
      statuses = response.ok ? await response.json() as Record<Provider, ProviderStatus> : undefined;
    } catch {
      statuses = undefined;
    }
  }
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  for (const [provider, name, has] of wanted) {
    if (!has) continue;
    const status = statuses?.[provider];
    if (!status) {
      add(name, "skipped", "The server gave no provider status: its function is older than this check, or it refused the token.");
      continue;
    }
    const used = `${status.used} of ${status.cap} requests ${provider === "google" ? "today" : "this month"}`;
    const last = status.refused ? `Last refused ${when(status.refused.at)} with ${status.refused.status}: "${status.refused.said}".` : "Never refused.";
    if (status.closedUntil) add(name, "fail", `Not being asked until ${when(status.closedUntil)}. ${last} (${used}.)`);
    else if (status.used >= status.cap) add(name, "fail", `The budget is spent: ${used}. ${last}`);
    else add(name, "pass", `${used}. ${last}`);
  }

  const order = ["App page", "Trip", "Connector", "Refresh route", "Photos", "Google", "NAVITIME"];
  return checks.sort((left, right) => order.indexOf(left.name) - order.indexOf(right.name));
}

/** A short table for the terminal. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  const mark = { pass: "ok  ", fail: "FAIL", skipped: "skip" } as const;
  return checks.map((check) => `  ${mark[check.status]}  ${check.name.padEnd(width)}  ${check.reason}`).join("\n");
}
