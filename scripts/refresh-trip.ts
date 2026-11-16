import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { downloadPlan } from "../packages/wanderlog-import/src/acquire.js";
import { loadIngestionConfig } from "../packages/wanderlog-import/src/config.js";
import { parseWanderlogSource } from "../packages/wanderlog-import/src/index.js";
import { parseTripBundle } from "../packages/trip-schema/src/index.js";
import { normaliseCompleteWanderlog } from "../packages/trip-normaliser/src/complete.js";
import { attachPlaceDetails } from "../packages/trip-normaliser/src/place-details.js";
import type { ImportOverrides } from "../packages/trip-normaliser/src/index.js";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: "config/trip.local.yaml" },
    source: { type: "string", default: "api" },
  },
});

if (!values.config) throw new Error("Missing config path");
if (values.source !== "api" && values.source !== "saved") {
  throw new Error("--source must be api or saved");
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
  source: string,
  report: ReturnType<typeof normaliseCompleteWanderlog>["report"],
): string {
  return [
    "# Wanderlog ingestion report",
    "",
    `- Source: ${source}`,
    `- Fingerprint: \`${report.sourceFingerprint}\``,
    `- Days: ${report.counts.days}`,
    `- Items: ${report.counts.items}`,
    `- Places: ${report.counts.places}`,
    `- Route legs: ${report.counts.routeLegs}`,
    `- Representative images: ${report.counts.images}`,
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

// "saved" processes the last download again: for a change to the import
// without asking Wanderlog.
const saved = values.source === "saved";
const contents = saved ? await readFile(rawJsonPath, "utf8") : await downloadPlan(config);
const source = saved ? "the last saved download" : "the Wanderlog API";
if (!saved) await writeAtomic(rawJsonPath, contents);

const parsed = parseWanderlogSource(contents);
let overrides: ImportOverrides | undefined;
const overridesPath = loaded.resolvePath(config.paths.overrides);
if (await exists(overridesPath)) {
  overrides = parseYaml(await readFile(overridesPath, "utf8")) as ImportOverrides;
}

const result = normaliseCompleteWanderlog(parsed.data, {
  sourceText: contents,
  ...(overrides ? { overrides } : {}),
});

result.bundle.tripId = config.trip.publicId;

const detailCount = attachPlaceDetails(result.bundle, parsed.data);

const workingBundlePath = loaded.resolvePath(config.paths.workingBundle);
const bundle = parseTripBundle(result.bundle);
const reportPath = loaded.resolvePath(config.paths.report);
const markdownReportPath = reportPath.replace(/\.json$/i, ".md");

await writeAtomic(workingBundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
await writeAtomic(reportPath, `${JSON.stringify({ source, ...result.report }, null, 2)}\n`);
await writeAtomic(markdownReportPath, reportMarkdown(source, result.report));

console.log(`Read the plan from ${source}.`);
console.log(`Raw plan: ${rawJsonPath}`);
console.log(`Generated TripBundle: ${workingBundlePath}`);
console.log(`Import report: ${reportPath}`);
console.log(`Place details: ${detailCount} places enriched from Wanderlog metadata.`);
console.log(
  "Photos, departure times and English town and line names come from the deployed site, which uses the Google and NAVITIME keys; this pull asks only Wanderlog.",
);
