import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTimetables } from "../packages/trip-normaliser/src/timetable-files.js";

const require = createRequire(import.meta.url);
// wrangler's own esbuild; it isn't a root dependency, so its types don't resolve here.
const esbuild = require(
  require.resolve("esbuild", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
) as { build(options: Record<string, unknown>): Promise<unknown> };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The worker builds live departure boards as a pull does, so it carries
// every trip's curated timetables (workers/refresh/live-boards.ts).
const trips = readdirSync(resolve(root, "data/trips"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
const timetables = Object.fromEntries(trips.map((trip) => [trip, loadTimetables(trip)]));

await esbuild.build({
  entryPoints: [resolve(root, "workers/refresh/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  // "neutral" reads no package entry fields; CommonJS-only packages
  // (tz-lookup) only have "main".
  mainFields: ["module", "main"],
  target: "es2022",
  outfile: resolve(root, "apps/web/.publish/_worker.js"),
  external: ["node:crypto"],
  define: { __TIMETABLES__: JSON.stringify(timetables) },
  logLevel: "info",
});
