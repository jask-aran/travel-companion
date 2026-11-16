import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  loadIngestionConfigSync,
  normaliseBase,
  parseIngestionConfig,
  parseWanderlogId,
  readSiteSettings,
  siteSettings,
} from "../packages/wanderlog-import/src/config.js";
import { writeInitialConfig } from "../packages/wanderlog-import/src/init-config.js";
import { wranglerConfig, wranglerConfigText } from "../scripts/wrangler-config.js";

const temporary: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "trip-config-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FULL = {
  trip: { wanderlogId: "abc123", publicId: "my-trip" },
  wanderlog: {
    api: { timeoutMs: 30000 },
  },
  google: { apiKey: "g", projectNumber: 42 },
  navitime: { apiKey: "n" },
  share: { passphrase: "pass" },
  paths: { rawJson: "a.json", overrides: "o.yaml", workingBundle: "w/working.json", report: "r.json" },
};

describe("config defaults", () => {
  it("needs only the Wanderlog id", () => {
    const config = parseIngestionConfig({ trip: { wanderlogId: "abc123" } });
    expect(config.trip.publicId).toBe("trip");
    expect(config.wanderlog).toEqual({ api: { timeoutMs: 60000 } });
    expect(config.paths).toEqual({
      rawJson: "private-import/wanderlog-trip.json",
      overrides: "private-import/overrides.yaml",
      workingBundle: "public-data/trips/trip/working.json",
      report: "private-import/import-report.json",
    });
    expect(config.site).toEqual({ base: "/" });
    expect(config.cloudflare).toBeUndefined();
    expect(config.share).toBeUndefined();
    expect(parseIngestionConfig({ trip: { wanderlogId: "abc123", publicId: "summer" } }).paths.workingBundle)
      .toBe("public-data/trips/summer/working.json");
  });

  it("keeps every value of a full config as given", () => {
    const config = parseIngestionConfig(structuredClone(FULL));
    const { site, cloudflare, ...rest } = config;
    expect(rest).toEqual(FULL);
    expect(site).toEqual({ base: "/" });
    expect(cloudflare).toBeUndefined();
  });

  it("rejects a config with no Wanderlog id", () => {
    expect(() => parseIngestionConfig({ trip: {} })).toThrow();
    expect(() => parseIngestionConfig({ trip: { wanderlogId: "" } })).toThrow();
  });

  it("explains how to make a config when there is none", () => {
    expect(() => loadIngestionConfigSync(join(tempDir(), "config/trip.local.yaml"))).toThrow(/pnpm trip:init/);
  });
});

describe("Wanderlog plan URLs", () => {
  it.each([
    ["  abc123\n", "abc123"],
    ["https://wanderlog.com/plan/abc123?tab=map#day-2", "abc123"],
    ["wanderlog.com/plan/abc123/", "abc123"],
    ["https://www.wanderlog.com/view/abc123/slug", "abc123"],
  ])("%j is %s", (input, id) => {
    expect(parseWanderlogId(input)).toBe(id);
  });

  it("accepts a pasted URL in the config", () => {
    const config = parseIngestionConfig({ trip: { wanderlogId: "https://wanderlog.com/plan/abc123/slug" } });
    expect(config.trip.wanderlogId).toBe("abc123");
  });
});

describe("site settings", () => {
  const config = parseIngestionConfig({
    trip: { wanderlogId: "abc123", publicId: "summer" },
    site: { base: "/summer/", origin: "https://trips.example.com/" },
    cloudflare: { project: "summer-trip", kvNamespaceId: "kv1", mediaBucket: "media" },
  });

  it("reads base, origin and Cloudflare from the config", () => {
    expect(siteSettings(config, {})).toEqual({
      base: "/summer/",
      origin: "https://trips.example.com",
      publicId: "summer",
      cloudflare: { project: "summer-trip", kvNamespaceId: "kv1", mediaBucket: "media" },
    });
  });

  it("lets TRIP_BASE and TRIP_ORIGIN override", () => {
    const site = siteSettings(config, { TRIP_BASE: "/other/", TRIP_ORIGIN: "https://other.example" });
    expect(site.base).toBe("/other/");
    expect(site.origin).toBe("https://other.example");
  });

  it("defaults to the root with no origin and no Cloudflare, even with no config file", () => {
    expect(readSiteSettings(join(tempDir(), "missing.yaml"), {})).toEqual({ base: "/", publicId: "trip" });
  });

  it("normalises the base path", () => {
    expect(normaliseBase("/")).toBe("/");
    expect(normaliseBase("")).toBe("/");
    expect(normaliseBase("summer")).toBe("/summer/");
    expect(normaliseBase("/summer")).toBe("/summer/");
  });
});

describe("trip:init config file", () => {
  it("writes the id and a generated passphrase, and nothing else", () => {
    const path = join(tempDir(), "config/trip.local.yaml");
    const { passphrase, generated } = writeInitialConfig(path, { wanderlog: "https://wanderlog.com/plan/abc123/slug" });
    expect(generated).toBe(true);
    expect(passphrase).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){5}$/);
    const written = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written).toEqual({ trip: { wanderlogId: "abc123" }, share: { passphrase } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadIngestionConfigSync(path).config.paths.workingBundle).toBe("public-data/trips/trip/working.json");
  });

  it("writes only the optional keys given", () => {
    const path = join(tempDir(), "config/trip.local.yaml");
    writeInitialConfig(path, {
      wanderlog: "abc123",
      googleKey: "gkey",
      googleProject: "1234",
      publicId: "summer",
      passphrase: "chosen words here",
    });
    expect(parseYaml(readFileSync(path, "utf8"))).toEqual({
      trip: { wanderlogId: "abc123", publicId: "summer" },
      share: { passphrase: "chosen words here" },
      google: { apiKey: "gkey", projectNumber: "1234" },
    });
  });

  it("refuses to overwrite an existing config", () => {
    const path = join(tempDir(), "trip.local.yaml");
    writeFileSync(path, "trip:\n  wanderlogId: keep\n");
    expect(() => writeInitialConfig(path, { wanderlog: "abc123" })).toThrow(/already exists/);
    expect(readFileSync(path, "utf8")).toBe("trip:\n  wanderlogId: keep\n");
  });
});

describe("generated wrangler config", () => {
  const site = (cloudflare: Record<string, string> | undefined) =>
    siteSettings(parseIngestionConfig({ trip: { wanderlogId: "abc123", publicId: "summer" }, ...(cloudflare ? { cloudflare } : {}) }), {});

  it("carries the project, KV namespace, bucket and public id from the config", () => {
    expect(wranglerConfig(site({ project: "summer-trip", kvNamespaceId: "kv1", mediaBucket: "media" }))).toMatchObject({
      name: "summer-trip",
      kv_namespaces: [{ binding: "TRIP", id: "kv1" }],
      r2_buckets: [{ binding: "MEDIA", bucket_name: "media" }],
      vars: { PUBLIC_ID: "summer" },
    });
  });

  it("writes JSONC with no bucket binding when there is no bucket", () => {
    const text = wranglerConfigText(site({ project: "summer-trip", kvNamespaceId: "kv1" }));
    const config = JSON.parse(text.replace(/^\/\/.*$/gm, ""));
    expect(config).not.toHaveProperty("r2_buckets");
    expect(config.kv_namespaces).toEqual([{ binding: "TRIP", id: "kv1" }]);
  });

  it("refuses a config with no cloudflare section", () => {
    expect(() => wranglerConfig(site(undefined))).toThrow(/no cloudflare section/);
  });
});
