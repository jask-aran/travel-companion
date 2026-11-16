import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encryptTrip } from "../apps/web/src/lib/trip-crypto.js";
import { MEDIA_ROUTES, mediaToken } from "../apps/web/src/lib/media.js";
import { PAGES_OUTPUT_DIR } from "./wrangler-config.js";

/**
 * Start the staged Pages function on workerd, Cloudflare's own runtime, and
 * ask it for one photo. The tests run in Node, which accepts a function
 * workerd refuses to start. Nothing leaves this computer: the trip is made
 * up, KV and R2 are in memory, and Google is answered here.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
type Runtime = {
  getKVNamespace(name: string): Promise<{ put(key: string, value: string): Promise<void> }>;
  dispatchFetch(url: string): Promise<Response>;
  dispose(): Promise<void>;
};
// wrangler's own Miniflare; it isn't a root dependency, so its types don't resolve here.
const { Miniflare, convertV4MiniflareOptions, Response: MfResponse } = (await import(
  require.resolve("miniflare", { paths: [dirname(require.resolve("wrangler/package.json"))] })
)) as {
  Miniflare: new (options: unknown) => Runtime;
  convertV4MiniflareOptions(options: Record<string, unknown>): unknown;
  Response: typeof Response;
};

const PASSPHRASE = "smoke";
const trip = {
  schemaVersion: 1, tripId: "smoke", revision: "r", generatedAt: "2026-01-01T00:00:00Z",
  trip: { title: "Smoke", startDate: "2026-12-01", endDate: "2026-12-01" },
  days: [], routeLegs: {},
  places: { "google-place:a": { id: "google-place:a", name: "A" } },
};

const asked: string[] = [];
const runtime = new Miniflare(convertV4MiniflareOptions({
  modules: [{ type: "ESModule", path: "worker.mjs", contents: readFileSync(resolve(root, PAGES_OUTPUT_DIR, "_worker.js"), "utf8") }],
  compatibilityDate: "2026-10-19",
  compatibilityFlags: ["nodejs_compat"],
  kvNamespaces: ["TRIP"],
  r2Buckets: ["MEDIA"],
  bindings: { PUBLIC_ID: "smoke", TRIP_PASSPHRASE: PASSPHRASE, GOOGLE_MAPS_API_KEY: "not-a-key" },
  serviceBindings: { ASSETS: () => new MfResponse(null, { status: 404 }) },
  outboundService: (request: Request) => {
    const url = new URL(request.url);
    asked.push(url.host);
    if (url.host !== "places.googleapis.com") return new MfResponse(null, { status: 599 });
    return url.pathname.endsWith("/media")
      ? new MfResponse("image", { headers: { "content-type": "image/jpeg" } })
      : MfResponse.json({ photos: [{ name: "places/a/photos/p" }] });
  },
}));

const problems: string[] = [];
try {
  await (await runtime.getKVNamespace("TRIP")).put("trip.enc", JSON.stringify(await encryptTrip(JSON.stringify(trip), PASSPHRASE)));
  const token = await mediaToken(PASSPHRASE);
  const photo = () => runtime.dispatchFetch(`https://smoke.test/trip/${MEDIA_ROUTES.photo}?place=a&t=${token}`);
  const first = await photo();
  await first.arrayBuffer();
  if (first.status !== 200 || first.headers.get("x-media") !== "image") {
    problems.push(`a photo came back ${first.status} x-media=${first.headers.get("x-media")}, expected 200 image`);
  }
  const before = asked.length;
  await (await photo()).arrayBuffer();
  if (asked.length !== before) problems.push("a stored photo asked Google again");
  const strangers = asked.filter((host) => host !== "places.googleapis.com");
  if (strangers.length) problems.push(`requests went to ${[...new Set(strangers)].join(", ")}`);
} catch (error) {
  problems.push(String(error));
} finally {
  await runtime.dispose().catch(() => undefined);
}

if (problems.length) {
  console.error("The Pages function failed on workerd:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`  The Pages function starts on workerd and serves a photo (${asked.length} mocked Google requests).`);
process.exit(0);
