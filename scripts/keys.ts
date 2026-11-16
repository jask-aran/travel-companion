import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseDocument } from "yaml";
import { DEFAULT_INGESTION_CONFIG_PATH, loadIngestionConfigSync } from "../packages/wanderlog-import/src/config.js";
import { checkKeys, formatKeyChecks, maskKey, type Keys } from "../packages/wanderlog-import/src/key-check.js";
import { spawnWrangler } from "./cloudflare-setup.js";

/**
 * `pnpm trip:keys`: test the API keys in config/trip.local.yaml, change them,
 * and send changed ones to the Cloudflare Pages project.
 *
 *   pnpm trip:keys            test, then offer to change any (Enter keeps one)
 *   pnpm trip:keys --check    test only
 *   --google-key K  --google-project N  --navitime-key K   change without asking
 *   --push                    send the config's keys to Cloudflare even if none changed
 *                             (after editing the config by hand)
 *   --yes                     send changed keys to Cloudflare and redeploy without asking
 *
 * A key is tested before it is saved. On Cloudflare a changed secret takes
 * effect on the next deploy, so sending one is followed by `pnpm ship`.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    check: { type: "boolean", default: false },
    "google-key": { type: "string" },
    "google-project": { type: "string" },
    "navitime-key": { type: "string" },
    yes: { type: "boolean", default: false },
    push: { type: "boolean", default: false },
    config: { type: "string", default: DEFAULT_INGESTION_CONFIG_PATH },
  },
});
const configPath = resolve(root, values.config!);
const shownConfig = relative(root, configPath);
const interactive = Boolean(process.stdin.isTTY);

let rl: Interface | undefined;
const ask = async (question: string): Promise<string> => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(question)).trim();
};
const askSecret = async (question: string): Promise<string> => {
  rl?.close();
  rl = undefined;
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() });
  const hidden = createInterface({ input: process.stdin, output: muted, terminal: true });
  const answer = await hidden.question("");
  hidden.close();
  process.stdout.write("\n");
  return answer.trim();
};
const finish = (code = 0): never => {
  rl?.close();
  process.exit(code);
};

let loaded: ReturnType<typeof loadIngestionConfigSync>;
try {
  loaded = loadIngestionConfigSync(configPath);
} catch (error) {
  console.error(`${shownConfig}: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run `pnpm trip:init` first.");
  finish(1);
}
const config = loaded!.config;
const current: Keys = {
  googleKey: config.google?.apiKey,
  googleProject: config.google?.projectNumber?.toString(),
  navitimeKey: config.navitime?.apiKey,
};

console.log(`Keys in ${shownConfig}:`);
console.log(`  Google Maps key         ${maskKey(current.googleKey)}`);
console.log(`  Google project number   ${current.googleProject ?? "not set"}`);
console.log(`  NAVITIME RapidAPI key   ${maskKey(current.navitimeKey)}`);

if (current.googleKey || current.navitimeKey) {
  console.log("\nTesting them (one small request to each API)…");
  console.log(formatKeyChecks(await checkKeys(current)));
} else {
  console.log("\nNo keys to test.");
}
if (values.check) finish(0);

// The new values: from flags, or asked for. Enter keeps a key; "-" removes it.
const given = values["google-key"] !== undefined || values["google-project"] !== undefined || values["navitime-key"] !== undefined;
if (!given && !interactive && !values.push) finish(0);
const next: Keys = { ...current };
if (given) {
  if (values["google-key"] !== undefined) next.googleKey = values["google-key"] || undefined;
  if (values["google-project"] !== undefined) next.googleProject = values["google-project"] || undefined;
  if (values["navitime-key"] !== undefined) next.navitimeKey = values["navitime-key"] || undefined;
} else if (!values.push) {
  if (!/^y(es)?$/i.test(await ask("\nChange any of them? [y/N] "))) finish(0);
  console.log("Paste a new value, press Enter to keep the current one, or type - to remove it. Keys are not shown as you paste.");
  const answer = (typed: string, kept: string | undefined) => (typed === "-" ? undefined : typed || kept);
  next.googleKey = answer(await askSecret("Google Maps key: "), current.googleKey);
  next.googleProject = answer(await ask("Google project number: "), current.googleProject);
  next.navitimeKey = answer(await askSecret("NAVITIME RapidAPI key: "), current.navitimeKey);
}

const NAMES = ["googleKey", "googleProject", "navitimeKey"] as const;
let changed: (typeof NAMES)[number][] = NAMES.filter((name) => next[name] !== current[name]);
const pushing = !changed.length && values.push;
if (!changed.length && !pushing) {
  console.log("Nothing changed.");
  finish(0);
}
if (next.googleProject && !/^\d+$/.test(next.googleProject)) {
  console.error("The Google project number is the number on the Cloud console's dashboard, all digits (not the project id).");
  finish(1);
}

// Test what changed before saving it.
if (!pushing) {
const testing: Keys = {
  ...(changed.includes("googleKey") || changed.includes("googleProject") ? { googleKey: next.googleKey, googleProject: next.googleProject } : {}),
  ...(changed.includes("navitimeKey") ? { navitimeKey: next.navitimeKey } : {}),
};
if (testing.googleKey || testing.navitimeKey) {
  console.log("\nTesting the new keys…");
  const checks = await checkKeys(testing);
  console.log(formatKeyChecks(checks));
  if (checks.some((check) => !check.ok)) {
    if (!interactive || !/^y(es)?$/i.test(await ask("Some failed. Save them anyway? [y/N] "))) {
      console.log("Nothing was saved.");
      finish(1);
    }
  }
}

const document = parseDocument(readFileSync(configPath, "utf8"));
const paths = { googleKey: ["google", "apiKey"], googleProject: ["google", "projectNumber"], navitimeKey: ["navitime", "apiKey"] } as const;
for (const name of changed) {
  const value = next[name];
  if (value) document.setIn([...paths[name]], value);
  else document.deleteIn([...paths[name]]);
}
writeFileSync(configPath, document.toString(), "utf8");
console.log(`\nSaved to ${shownConfig}.`);
} else {
  // Sending what the config holds: every key it has.
  changed = NAMES.filter((name) => next[name]);
}

// Cloudflare: the same names cloudflare-setup.ts sets.
const project = config.cloudflare?.project;
if (!project) {
  console.log("No Cloudflare project in the config: the keys are used by `pnpm trip:pull` only. Deploy with `pnpm trip:init` to use them on Cloudflare.");
  finish(0);
}
const secretNames = { googleKey: "GOOGLE_MAPS_API_KEY", googleProject: "GOOGLE_PROJECT_NUMBER", navitimeKey: "NAVITIME_API_KEY" } as const;
console.log(`\nOn Cloudflare (Pages project ${project}):`);
for (const name of changed) {
  console.log(`  ${next[name] ? "set" : "delete"} the secret ${secretNames[name]}`);
}
console.log("  then `pnpm ship`, since a secret takes effect on the next deploy (the app is redeployed; the trip is left alone)");
if (next.googleKey && !config.cloudflare?.mediaBucket && !config.cloudflare?.connectorOnly) {
  console.log("  Note: there is no R2 bucket for photos in the config. Choose deploy in `pnpm trip:init` to create one.");
}
if (!values.yes && !(interactive && /^y(es)?$/i.test(await ask("Go ahead? [y/N] ")))) {
  console.log("Not sent. Run `pnpm trip:keys` again to send them, or set them in the Cloudflare dashboard (Settings → Variables and Secrets) and run `pnpm ship`.");
  finish(0);
}

const wrangler = spawnWrangler(root);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...(config.cloudflare?.apiToken ? { CLOUDFLARE_API_TOKEN: config.cloudflare.apiToken } : {}),
  ...(config.cloudflare?.accountId ? { CLOUDFLARE_ACCOUNT_ID: config.cloudflare.accountId } : {}),
};
for (const name of changed) {
  const value = next[name];
  const args = value
    ? ["pages", "secret", "put", secretNames[name], "--project-name", project!]
    : ["pages", "secret", "delete", secretNames[name], "--project-name", project!];
  console.log(`▸ wrangler ${args.join(" ")}`);
  // The key goes on stdin, never on the command line; delete asks to confirm, so it gets a "y".
  const result = wrangler(args, { env, input: value ?? "y\n" });
  if (result.status !== 0) {
    console.error(`That failed (exit ${result.status ?? "signal"}). The config is saved; fix the problem and run \`pnpm trip:keys\` again.`);
    finish(1);
  }
}
rl?.close();
rl = undefined;
const { spawnSync } = await import("node:child_process");
const ship = spawnSync("pnpm", ["ship"], { cwd: root, stdio: "inherit" });
finish(ship.status ?? 1);
