import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { parseWanderlogSource } from "../packages/wanderlog-import/src/index.js";
import { normaliseCompleteWanderlog } from "../packages/trip-normaliser/src/complete.js";
import type { ImportOverrides } from "../packages/trip-normaliser/src/index.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    output: { type: "string", short: "o" },
    overrides: { type: "string" },
    report: { type: "string" },
  },
});

const inputArgument = positionals[0];
if (!inputArgument) {
  console.error("Usage: pnpm trip:import <wanderlog.json|wanderlog.html> [--output path] [--overrides path]");
  process.exit(2);
}

const inputPath = resolve(inputArgument);
const sourceText = await readFile(inputPath, "utf8");
const parsed = parseWanderlogSource(sourceText);

let overrides: ImportOverrides | undefined;
if (values.overrides) {
  overrides = parseYaml(await readFile(resolve(values.overrides), "utf8")) as ImportOverrides;
}

const { bundle, report } = normaliseCompleteWanderlog(parsed.data, {
  sourceKind: parsed.kind,
  sourceText,
  ...(overrides ? { overrides } : {}),
});

const defaultName = basename(inputPath, extname(inputPath));
const outputPath = resolve(values.output ?? join("public-data", "trips", bundle.tripId, `${defaultName}.working.json`));
const reportPath = resolve(values.report ?? join(dirname(inputPath), "import-report.json"));
const reportMarkdownPath = reportPath.replace(/\.json$/i, ".md");

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const markdown = [
  "# Wanderlog import report",
  "",
  `- Source: \`${parsed.kind}\``,
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
  ...(report.warnings.length ? report.warnings.map((warning) => `- **${warning.code}:** ${warning.message}`) : ["- None"]),
  "",
].join("\n");
await writeFile(reportMarkdownPath, markdown, "utf8");

console.log(`Imported ${report.counts.days} days, ${report.counts.items} items, and ${report.counts.places} places.`);
console.log(`TripBundle: ${outputPath}`);
console.log(`Report: ${reportPath}`);
