import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// wrangler's own esbuild; it isn't a root dependency, so its types don't resolve here.
const esbuild = require(
  require.resolve("esbuild", { paths: [dirname(require.resolve("wrangler/package.json"))] }),
) as { build(options: Record<string, unknown>): Promise<unknown> };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
  logLevel: "info",
});
