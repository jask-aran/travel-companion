import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIngestionConfigSync, siteSettings } from "../packages/wanderlog-import/src/config.js";
import { agentLink, agentToken } from "../apps/web/src/lib/agent-link.js";
import { PAGES_OUTPUT_DIR, writeWranglerConfig } from "./wrangler-config.js";
import { formatChecks, verifyLive } from "./verify-live.js";

/**
 * Ship to Cloudflare Pages: the app and the Pages function. The trip is not
 * uploaded: the function pulls Wanderlog itself into KV, and until its first
 * pull serves the build's own `trip.enc`. A connector-only deployment
 * (`cloudflare.connectorOnly`) uploads the function with a placeholder page.
 * Before any upload the staged function is started on workerd
 * (smoke-function.ts). `--dry-run` builds and stages, uploads nothing. `--check` only checks the
 * live site (verify-live.ts), as every ship ends.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const checkOnly = args.has("--check");

const configPath = resolve(root, "config/trip.local.yaml");
const loaded = loadIngestionConfigSync(configPath);
const connectorOnly = loaded.config.cloudflare?.connectorOnly === true;
const site = siteSettings(loaded.config);
const { base, origin, cloudflare } = site;
if (!cloudflare) {
  console.error("config/trip.local.yaml has no cloudflare section, so there is no Pages project to ship to.");
  console.error("Run `pnpm trip:init` and choose deploy to create one, or deploy apps/web/dist from `pnpm build` to any static host.");
  process.exit(1);
}
/** Check the live site works; false if any check failed. */
async function checkLive(): Promise<boolean> {
  const passphrase = loaded.config.share?.passphrase;
  if (!passphrase) {
    console.log("  No share.passphrase in config/trip.local.yaml, so the trip and connector can't be checked.");
    return false;
  }
  const checks = await verifyLive({
    site: `${origin}${base}`,
    passphrase,
    connectorOnly,
    mediaBucket: Boolean(cloudflare?.mediaBucket),
    googleKey: Boolean(loaded.config.google?.apiKey),
    navitimeKey: Boolean(loaded.config.navitime?.apiKey),
  });
  console.log(formatChecks(checks));
  return checks.every((check) => check.status !== "fail");
}

if (checkOnly) {
  if (!origin) {
    console.error("config/trip.local.yaml has no site.origin, so there is no live site to check. Set it to the site's address, e.g. https://trips.example.com.");
    process.exit(1);
  }
  console.log(`Checking ${origin}${base}`);
  process.exit((await checkLive()) ? 0 : 1);
}

const dist = resolve(root, "apps/web/dist");

/**
 * Cloudflare credentials from the config reach wrangler through its
 * environment, never its arguments, so they are not shown or logged.
 */
// Read from the full config: the site settings leave credentials out so they cannot reach the build.
const credentials = loaded.config.cloudflare;
const wranglerEnv: NodeJS.ProcessEnv = {
  ...process.env,
  ...(credentials?.apiToken ? { CLOUDFLARE_API_TOKEN: credentials.apiToken } : {}),
  ...(credentials?.accountId ? { CLOUDFLARE_ACCOUNT_ID: credentials.accountId } : {}),
};

const seconds = (since: number) => `${((performance.now() - since) / 1000).toFixed(1)}s`;

/** Run one command with its output shown, and fail the ship if it fails. */
function run(label: string, command: string, commandArgs: string[]): Promise<void> {
  const started = performance.now();
  console.log(`\n▸ ${label}`);
  return new Promise((done, fail) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: "inherit", env: command === "wrangler" ? wranglerEnv : process.env });
    child.on("error", fail);
    child.on("exit", (code) => {
      if (code === 0) {
        console.log(`  ${label}: ${seconds(started)}`);
        done();
      } else {
        fail(new Error(`${label} failed (exit ${code ?? "signal"}): ${command} ${commandArgs.join(" ")}`));
      }
    });
  });
}

/** The hashed script the build's index.html loads: it names this build. */
function builtScript(): string {
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  const match = html.match(/assets\/index-[\w-]+\.js/);
  if (!match) throw new Error("Could not find the built script in apps/web/dist/index.html");
  return match[0];
}

/** Ask the live site for its index.html until it names this build. */
async function waitUntilLive(script: string): Promise<boolean> {
  const url = `${origin}${base}index.html`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}?ship=${Date.now()}`, { cache: "no-store" });
      if (response.ok && (await response.text()).includes(script)) return true;
    } catch {
      // Offline or mid-deploy: keep asking until the deadline.
    }
    await new Promise((tick) => setTimeout(tick, 2000));
  }
  return false;
}

const started = performance.now();
const what = connectorOnly ? "the connector" : "the app";
console.log(`Shipping ${what}${dryRun ? " (dry run: nothing is uploaded)" : ""}`);

console.log(`Wrote ${writeWranglerConfig(root, site).replace(`${root}/`, "")} for Pages project ${cloudflare.project}`);

if (connectorOnly) {
  // Pages wants a page to upload beside _worker.js; it says nothing about the trip.
  const publish = resolve(root, PAGES_OUTPUT_DIR);
  rmSync(publish, { recursive: true, force: true });
  mkdirSync(publish, { recursive: true });
  writeFileSync(resolve(publish, "index.html"), "<!doctype html><meta charset=utf-8><title>Connector</title><p>Nothing to see here.\n");
} else {
  await run("Build the app", "pnpm", ["build"]);
  await run("Stage for Pages", "tsx", ["scripts/publish.ts"]);
}
await run("Bundle the Pages function", "tsx", ["scripts/bundle-refresh.ts"]);
await run("Start the function on workerd", "tsx", ["scripts/smoke-function.ts"]);

const deploy = [
  "pages", "deploy", PAGES_OUTPUT_DIR,
  "--project-name", cloudflare.project, "--branch", "main", "--commit-dirty",
];

if (dryRun) {
  console.log(`\nDry run. Would run: wrangler ${deploy.join(" ")}`);
  console.log(`\nBuilt and staged in ${seconds(started)}. Nothing was uploaded.`);
  process.exit(0);
}

await run("Upload the Pages deployment", "wrangler", deploy);

if (connectorOnly && origin && loaded.config.share?.passphrase) {
  console.log("\nPaste this into Claude or ChatGPT as a custom connector:");
  console.log(`  ${agentLink(`${origin}${base}`, await agentToken(loaded.config.share.passphrase))}`);
  console.log("The link is the secret: whoever has it can read the whole trip.");
}

if (!origin) {
  console.log(`\nShipped ${what} in ${seconds(started)}. Set site.origin in config/trip.local.yaml to have ship check the live site.`);
  process.exit(0);
}

if (!connectorOnly) {
  console.log("\n▸ Check the live site");
  const script = builtScript();
  if (await waitUntilLive(script)) {
    console.log(`  ${origin}${base} is serving this build (${script}).`);
  } else {
    console.log(`  ${origin}${base} did not show this build (${script}) within 60s.`);
    console.log("  The upload succeeded; the site may still be switching over. Reload it to check.");
    process.exitCode = 1;
  }
}
console.log("\n▸ Check the deployment works");
if (!(await checkLive())) {
  console.log("  Something above failed: the deploy went up, but travellers may not be able to use it.");
  process.exitCode = 1;
}
console.log(`\nShipped ${what} in ${seconds(started)}. ${connectorOnly ? "" : " Installed phones pick the new app up on their next reload."}`);
