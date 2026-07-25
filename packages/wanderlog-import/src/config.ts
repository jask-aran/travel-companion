import { readFile } from "node:fs/promises";
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
      command: v.optional(v.string(), "wanderlog"),
      timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 60000),
    }),
    web: v.object({
      url: v.pipe(v.string(), v.url()),
      browserProfileDir: RelativePathSchema,
      headless: v.optional(v.boolean(), true),
      timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1000)), 60000),
    }),
  }),
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

export async function loadIngestionConfig(configPath = "config/trip.yaml"): Promise<LoadedIngestionConfig> {
  const absoluteConfigPath = resolve(configPath);
  const raw = parseYaml(await readFile(absoluteConfigPath, "utf8")) as unknown;
  const config = v.parse(IngestionConfigSchema, raw);
  const projectRoot = resolve(dirname(absoluteConfigPath), "..");

  return {
    config,
    configPath: absoluteConfigPath,
    projectRoot,
    resolvePath: (path) => resolve(projectRoot, path),
  };
}
