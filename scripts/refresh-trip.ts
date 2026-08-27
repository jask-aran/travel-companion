import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { acquireWithBrowser, acquireWithCli, type AcquiredSource } from "../packages/wanderlog-import/src/acquire.js";
import { loadIngestionConfig } from "../packages/wanderlog-import/src/config.js";
import { parseWanderlogSource } from "../packages/wanderlog-import/src/index.js";
import { parseTripBundle } from "../packages/trip-schema/src/index.js";
import { normaliseCompleteWanderlog } from "../packages/trip-normaliser/src/complete.js";
import { attachPlacePhotos } from "../packages/trip-normaliser/src/place-photos.js";
import { attachPlaceDetails } from "../packages/trip-normaliser/src/place-details.js";
import type { ImportOverrides } from "../packages/trip-normaliser/src/index.js";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "config/trip.local.yaml" },
    source: { type: "string", default: "auto" },
    headed: { type: "boolean", default: false },
  },
});

if (!values.config) throw new Error("Missing config path");
if (!values.source || !["auto", "cli", "html"].includes(values.source)) {
  throw new Error("--source must be auto, cli, or html");
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function reportMarkdown(
  source: AcquiredSource,
  report: ReturnType<typeof normaliseCompleteWanderlog>["report"],
): string {
  return [
    "# Wanderlog ingestion report",
    "",
    `- Acquisition source: \`${source.source}\``,
    `- Fingerprint: \`${report.sourceFingerprint}\``,
    `- Days: ${report.counts.days}`,
    `- Items: ${report.counts.items}`,
    `- Places: ${report.counts.places}`,
    `- Route legs: ${report.counts.routeLegs}`,
    `- Representative images: ${report.counts.images}`,
    "",
    "## Acquisition",
    "",
    ...source.diagnostics.map((entry) => `- ${entry}`),
    "",
    "## Redacted by design",
    "",
    ...report.redacted.map((entry) => `- ${entry}`),
    "",
    "## Warnings",
    "",
    ...(report.warnings.length
      ? report.warnings.map((warning) => `- **${warning.code}:** ${warning.message}`)
      : ["- None"]),
    "",
  ].join("\n");
}

const loaded = await loadIngestionConfig(values.config);
const { config } = loaded;
const rawJsonPath = loaded.resolvePath(config.paths.rawJson);
const rawHtmlPath = loaded.resolvePath(config.paths.rawHtml);
const profilePath = loaded.resolvePath(config.wanderlog.web.browserProfileDir);

let acquired: AcquiredSource;
if (values.source === "cli") {
  acquired = await acquireWithCli(config);
} else if (values.source === "html") {
  acquired = await acquireWithBrowser(config, profilePath, { headless: !values.headed });
} else {
  try {
    acquired = await acquireWithCli(config);
  } catch (cliError) {
    console.warn(`Wanderlog CLI acquisition failed: ${cliError instanceof Error ? cliError.message : String(cliError)}`);
    console.warn("Falling back to browser scraping.");
    acquired = await acquireWithBrowser(config, profilePath, { headless: !values.headed });
    acquired.diagnostics.unshift(`CLI fallback reason: ${cliError instanceof Error ? cliError.message : String(cliError)}`);
  }
}

const rawPath = acquired.source === "cli" ? rawJsonPath : rawHtmlPath;
await writeAtomic(rawPath, acquired.contents);

const parsed = parseWanderlogSource(acquired.contents);
let overrides: ImportOverrides | undefined;
const overridesPath = loaded.resolvePath(config.paths.overrides);
if (await exists(overridesPath)) {
  overrides = parseYaml(await readFile(overridesPath, "utf8")) as ImportOverrides;
}

const result = normaliseCompleteWanderlog(parsed.data, {
  sourceKind: parsed.kind,
  sourceText: acquired.contents,
  ...(overrides ? { overrides } : {}),
});

result.bundle.tripId = config.trip.publicId;

// Wanderlog's own scraped POI records: categories, blurb, hours, visit length.
const detailCount = attachPlaceDetails(result.bundle, parsed.data);

/*
 * Google photo names expire and may not be cached, so they are refreshed here
 * on every ingest. Without a key the app simply renders no photos.
 */
const googleApiKey = process.env.GOOGLE_MAPS_API_KEY ?? config.google?.apiKey;
const photoReport = await attachPlacePhotos(result.bundle, googleApiKey);

const bundle = parseTripBundle(result.bundle);
const workingBundlePath = loaded.resolvePath(config.paths.workingBundle);
const reportPath = loaded.resolvePath(config.paths.report);
const markdownReportPath = reportPath.replace(/\.json$/i, ".md");

await writeAtomic(workingBundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
await writeAtomic(reportPath, `${JSON.stringify({ acquisition: acquired.diagnostics, ...result.report }, null, 2)}\n`);
await writeAtomic(markdownReportPath, reportMarkdown(acquired, result.report));

console.log(`Acquired Wanderlog trip ${config.trip.wanderlogId} via ${acquired.source}.`);
console.log(`Saved raw source: ${rawPath}`);
console.log(`Generated TripBundle: ${workingBundlePath}`);
console.log(`Import report: ${reportPath}`);
console.log(`Place details: ${detailCount} places enriched from Wanderlog metadata.`);
if (photoReport.skipped && !photoReport.requested) {
  console.log(
    "Place photos: skipped. Set google.apiKey in config/trip.local.yaml (or GOOGLE_MAPS_API_KEY) to fetch them.",
  );
} else {
  console.log(
    `Place photos: ${photoReport.attached} attached, ${photoReport.failed} failed, ${photoReport.skipped} skipped.`,
  );
  for (const message of photoReport.errors) console.warn(`  ! ${message}`);
}
