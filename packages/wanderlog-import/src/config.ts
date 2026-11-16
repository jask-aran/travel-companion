import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";

/** The local trip config. Only `trip.wanderlogId` is required. */

const RelativePathSchema = v.pipe(v.string(), v.minLength(1));
const TimeoutSchema = v.pipe(v.number(), v.integer(), v.minValue(1000));

/** A bare id, or a pasted plan URL: https://wanderlog.com/plan/<id>/<slug>. */
export function parseWanderlogId(input: string): string {
  const text = input.trim();
  const match = /^(?:https?:\/\/)?(?:www\.)?wanderlog\.com\/(?:plan|view)\/([^/?#\s]+)/i.exec(text);
  return match ? match[1]! : text;
}

const RawConfigSchema = v.object({
  trip: v.object({
    wanderlogId: v.pipe(v.string(), v.transform(parseWanderlogId), v.minLength(1)),
    /** Slug for local output paths, the bundle's tripId and the worker's storage keys. */
    publicId: v.optional(v.pipe(v.string(), v.minLength(1)), "trip"),
  }),
  wanderlog: v.optional(
    v.object({
      api: v.optional(v.object({ timeoutMs: v.optional(TimeoutSchema, 60000) }), {}),
    }),
    {},
  ),
  /** Server APIs and separately restricted browser maps credentials. */
  google: v.optional(
    v.object({
      apiKey: v.optional(v.string()),
      /** Public website-restricted key for Maps JavaScript API; never reuse apiKey. */
      browserApiKey: v.optional(v.string()),
      mapId: v.optional(v.string()),
      /** Project number, for the Translation LLM (line names); standard model without it. */
      projectNumber: v.optional(v.union([v.string(), v.number()])),
    }),
  ),
  /** NAVITIME (RapidAPI): Japan departure times, which Google does not cover. */
  navitime: v.optional(v.object({ apiKey: v.optional(v.string()) })),
  /** Without it the build publishes plaintext, which is only safe privately. */
  share: v.optional(v.object({ passphrase: v.optional(v.string()) })),
  paths: v.optional(
    v.object({
      rawJson: v.optional(RelativePathSchema, "private-import/wanderlog-trip.json"),
      overrides: v.optional(RelativePathSchema, "private-import/overrides.yaml"),
      workingBundle: v.optional(RelativePathSchema),
      report: v.optional(RelativePathSchema, "private-import/import-report.json"),
    }),
    {},
  ),
  site: v.optional(
    v.object({
      /** Path the app is served under, e.g. "/" or "/my-trip/". */
      base: v.optional(v.pipe(v.string(), v.minLength(1)), "/"),
      /** Where the site is live, e.g. https://trips.example.com. */
      origin: v.optional(v.pipe(v.string(), v.url())),
    }),
    {},
  ),
  /** Present only for a Cloudflare Pages deployment (the Pages function). */
  cloudflare: v.optional(
    v.object({
      project: v.pipe(v.string(), v.minLength(1)),
      kvNamespaceId: v.optional(v.pipe(v.string(), v.minLength(1))),
      mediaBucket: v.optional(v.pipe(v.string(), v.minLength(1))),
      /** For wrangler as CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN; without them, `wrangler login`. */
      accountId: v.optional(v.pipe(v.string(), v.minLength(1))),
      apiToken: v.optional(v.pipe(v.string(), v.minLength(1))),
      /** The hosted connector without the app: `pnpm ship` uploads only the function. */
      connectorOnly: v.optional(v.boolean()),
    }),
  ),
});

type RawConfig = v.InferOutput<typeof RawConfigSchema>;

/** The config with every default filled in. */
export type IngestionConfig = Omit<RawConfig, "wanderlog" | "paths" | "site"> & {
  wanderlog: {
    api: { timeoutMs: number };
  };
  paths: {
    rawJson: string;
    overrides: string;
    workingBundle: string;
    report: string;
  };
  site: { base: string; origin?: string | undefined };
};

/** The server key is deliberately not a fallback for a public browser key. */
export function browserMapSettings(config: Pick<IngestionConfig, "google">): { key: string; mapId: string } {
  return { key: config.google?.browserApiKey ?? "", mapId: config.google?.mapId ?? "DEMO_MAP_ID" };
}

/** Validate a parsed YAML document and fill in the defaults. */
export function parseIngestionConfig(raw: unknown): IngestionConfig {
  const config = v.parse(RawConfigSchema, raw);
  const { publicId } = config.trip;
  const { workingBundle, ...paths } = config.paths;
  return {
    ...config,
    paths: { ...paths, workingBundle: workingBundle ?? `public-data/trips/${publicId}/working.json` },
    site: config.site,
  };
}

export interface LoadedIngestionConfig {
  config: IngestionConfig;
  configPath: string;
  projectRoot: string;
  resolvePath(path: string): string;
}

export const DEFAULT_INGESTION_CONFIG_PATH = "config/trip.local.yaml";
const EXAMPLE_INGESTION_CONFIG_PATH = "config/trip.example.yaml";

function missingLocalConfigError(absolutePath: string): Error {
  return new Error(
    [
      `Missing local ingestion config: ${absolutePath}`,
      "Run `pnpm trip:init <wanderlog plan URL>` to write one, or create it with:",
      "  trip:",
      "    wanderlogId: <id from https://wanderlog.com/plan/<id>/...>",
      `${EXAMPLE_INGESTION_CONFIG_PATH} lists every optional key. trip.local.yaml is gitignored.`,
    ].join("\n"),
  );
}

/** Synchronous, for Vite's config and the ship scripts. */
export function loadIngestionConfigSync(configPath = DEFAULT_INGESTION_CONFIG_PATH): LoadedIngestionConfig {
  const absoluteConfigPath = resolve(configPath);
  if (!existsSync(absoluteConfigPath)) throw missingLocalConfigError(absoluteConfigPath);

  const config = parseIngestionConfig(parseYaml(readFileSync(absoluteConfigPath, "utf8")) as unknown);
  if (config.trip.wanderlogId.startsWith("YOUR_")) {
    throw new Error(
      `${absoluteConfigPath} still has placeholder trip.wanderlogId. Replace it with the real Wanderlog trip id from the plan URL.`,
    );
  }

  const projectRoot = resolve(dirname(absoluteConfigPath), "..");
  return {
    config,
    configPath: absoluteConfigPath,
    projectRoot,
    resolvePath: (path) => resolve(projectRoot, path),
  };
}

export async function loadIngestionConfig(
  configPath = DEFAULT_INGESTION_CONFIG_PATH,
): Promise<LoadedIngestionConfig> {
  return loadIngestionConfigSync(configPath);
}

/** "/", or a path with one leading and one trailing slash. */
export function normaliseBase(base: string): string {
  const trimmed = base.trim().replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

/**
 * The facts the build and the deploy scripts share: where the app is served,
 * and whether (and where) it runs on Cloudflare Pages. `TRIP_BASE` and
 * `TRIP_ORIGIN` override the config.
 */
export interface SiteSettings {
  base: string;
  origin?: string;
  publicId: string;
  cloudflare?: { project: string; kvNamespaceId?: string | undefined; mediaBucket?: string | undefined };
}

export function siteSettings(
  config: IngestionConfig,
  env: Record<string, string | undefined> = process.env,
): SiteSettings {
  const origin = env.TRIP_ORIGIN || config.site.origin;
  return {
    base: normaliseBase(env.TRIP_BASE || config.site.base),
    ...(origin ? { origin: origin.replace(/\/+$/, "") } : {}),
    publicId: config.trip.publicId,
    // Ids only: the token stays out of anything the build sees.
    ...(config.cloudflare
      ? { cloudflare: { project: config.cloudflare.project, kvNamespaceId: config.cloudflare.kvNamespaceId, mediaBucket: config.cloudflare.mediaBucket } }
      : {}),
  };
}

/**
 * Site settings from the config file, or the neutral defaults (base "/", no
 * origin, no Cloudflare) when there is no config yet: Vite reads this before
 * the trip plugin reports the missing file properly.
 */
export function readSiteSettings(
  configPath = DEFAULT_INGESTION_CONFIG_PATH,
  env: Record<string, string | undefined> = process.env,
): SiteSettings {
  if (!existsSync(resolve(configPath))) {
    return siteSettings(parseIngestionConfig({ trip: { wanderlogId: "unset" } }), env);
  }
  return siteSettings(loadIngestionConfigSync(configPath).config, env);
}
