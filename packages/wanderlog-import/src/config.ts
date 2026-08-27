import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

const RelativePathSchema = v.pipe(v.string(), v.minLength(1));

const IngestionConfigSchema = v.object({
  trip: v.object({
    wanderlogId: v.pipe(v.string(), v.minLength(1)),
    publicId: v.pipe(v.string(), v.minLength(1)),
  }),
  wanderlog: v.object({
    cli: v.object({
      command: v.optional(v.string(), "wanderlog-cli"),
      timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 60000),
    }),
    web: v.object({
      url: v.pipe(v.string(), v.url()),
      browserProfileDir: RelativePathSchema,
      headless: v.optional(v.boolean(), true),
      timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 60000),
    }),
  }),
  /**
   * Google Maps browser key for Place Photos. Optional — without it the app
   * simply renders no photos. Lives here because this file is gitignored.
   */
  google: v.optional(
    v.object({
      apiKey: v.optional(v.string()),
    }),
  ),
  /**
   * Passphrase used to encrypt the published trip payload. Optional — with no
   * passphrase the build publishes plaintext, which is only safe privately.
   */
  share: v.optional(v.object({ passphrase: v.optional(v.string()) })),
  paths: v.object({
    rawJson: RelativePathSchema,
    rawHtml: RelativePathSchema,
    overrides: RelativePathSchema,
    workingBundle: RelativePathSchema,
    report: RelativePathSchema,
  }),
});

export type IngestionConfig = v.InferOutput<typeof IngestionConfigSchema>;

export interface LoadedIngestionConfig {
  config: IngestionConfig;
  configPath: string;
  projectRoot: string;
  resolvePath(path: string): string;
}

/** Default local config path — gitignored, holds the real Wanderlog trip id. */
export const DEFAULT_INGESTION_CONFIG_PATH = "config/trip.local.yaml";
export const EXAMPLE_INGESTION_CONFIG_PATH = "config/trip.example.yaml";

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function missingLocalConfigError(absolutePath: string): Error {
  return new Error(
    [
      `Missing local ingestion config: ${absolutePath}`,
      `Copy ${EXAMPLE_INGESTION_CONFIG_PATH} to ${DEFAULT_INGESTION_CONFIG_PATH} and set trip.wanderlogId (and the Wanderlog URL).`,
      "trip.local.yaml is gitignored so the Wanderlog trip code never enters the repo.",
    ].join("\n"),
  );
}

export async function loadIngestionConfig(
  configPath = DEFAULT_INGESTION_CONFIG_PATH,
): Promise<LoadedIngestionConfig> {
  const absoluteConfigPath = resolve(configPath);

  if (!(await pathExists(absoluteConfigPath))) {
    throw missingLocalConfigError(absoluteConfigPath);
  }

  const raw = parseYaml(await readFile(absoluteConfigPath, "utf8")) as unknown;
  const config = v.parse(IngestionConfigSchema, raw);

  if (config.trip.wanderlogId.startsWith("YOUR_")) {
    throw new Error(
      `${absoluteConfigPath} still has placeholder trip.wanderlogId. Replace it with the real Wanderlog trip id from the plan URL.`,
    );
  }

  // Config lives in <repo>/config/; repo root is the parent of that directory.
  const projectRoot = resolve(dirname(absoluteConfigPath), "..");

  return {
    config,
    configPath: absoluteConfigPath,
    projectRoot,
    resolvePath: (path) => resolve(projectRoot, path),
  };
}
