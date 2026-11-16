import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_INGESTION_CONFIG_PATH, loadIngestionConfigSync } from "../packages/wanderlog-import/src/config.js";
import { writeInitialConfig } from "../packages/wanderlog-import/src/init-config.js";
import { checkKeys, formatKeyChecks } from "../packages/wanderlog-import/src/key-check.js";
import { setupCloudflare } from "./cloudflare-setup.js";

/**
 * Writes config/trip.local.yaml, pulls and builds, then offers a menu. With a
 * config already there it goes straight to the menu and leaves the file alone.
 *
 * Every answer has a flag, so it also runs without a terminal:
 *   --id <plan URL or id>  --google-key K  --google-project N  --navitime-key K
 *   --no-pull              write the config only
 *   --action dev|mcp|deploy|connector|keys|quit   run one menu action and exit
 *                          (connector: only the hosted connector, no app)
 *   --yes                  agree to the Cloudflare plan without asking
 *   --dry-run              with deploy or connector: print the wrangler commands, change nothing
 *   --project <name>       Pages project name for deploy
 *   --path </trip/>        path to serve the site under (default the config's site.base)
 *   --domain <host>        custom domain (default none: <project>.pages.dev)
 *   --api-token-env <NAME> read a Cloudflare API token from that environment variable
 *   --account <id>         Cloudflare account, when the login has several
 * Given --id, the optional keys not given are skipped rather than asked for.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    id: { type: "string" },
    "google-key": { type: "string" },
    "google-project": { type: "string" },
    "navitime-key": { type: "string" },
    "no-pull": { type: "boolean", default: false },
    action: { type: "string" },
    yes: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    project: { type: "string" },
    path: { type: "string" },
    domain: { type: "string" },
    "api-token-env": { type: "string" },
    account: { type: "string" },
    config: { type: "string", default: DEFAULT_INGESTION_CONFIG_PATH },
  },
});

const configPath = resolve(root, values.config!);
const shownConfig = relative(root, configPath);
const interactive = Boolean(process.stdin.isTTY);
const ACTIONS = ["dev", "mcp", "deploy", "connector", "keys", "quit"] as const;
type Action = (typeof ACTIONS)[number];
if (values.action && !ACTIONS.includes(values.action as Action)) {
  console.error(`--action must be one of ${ACTIONS.join(", ")}.`);
  process.exit(2);
}

let rl: Interface | undefined;
const ask = async (question: string): Promise<string> => {
  if (!interactive) throw new Error(`No terminal to ask: ${question.trim()} Pass it as a flag.`);
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(question)).trim();
};
/** Like ask, but what is typed is not echoed. */
const askSecret = async (question: string): Promise<string> => {
  if (!interactive) throw new Error(`No terminal to ask: ${question.trim()} Pass it as a flag.`);
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
/** Hand the terminal to a child (dev server, connector) until it exits; Ctrl+C stops the child, not this menu. */
function runAttached(command: string, args: string[]): Promise<number> {
  rl?.close();
  rl = undefined;
  const ignore = () => {};
  process.on("SIGINT", ignore);
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.on("error", () => done(1));
    child.on("exit", (code) => {
      process.off("SIGINT", ignore);
      done(code ?? 0);
    });
  });
}

const comeBack = [
  "  pnpm trip:init    this menu again",
  "  pnpm trip:keys    test the API keys, or change them (here and on Cloudflare)",
  "  pnpm dev          preview the site on this computer",
  "  pnpm mcp          the connector on this computer",
  "  pnpm ship:check   check the online site works, and what Google and NAVITIME last refused",
  "  pnpm ship         redeploy after changing this code (plan changes need nothing)",
];

if (existsSync(configPath)) {
  console.log(`Using ${shownConfig} (left as it is).`);
} else {
  let id = values.id;
  const flagsOnly = Boolean(id);
  if (!id) {
    console.log("Set up a trip from a Wanderlog plan.\n");
    while (!id) id = await ask("Wanderlog plan URL or id: ");
  }
  const optional = async (flag: string | undefined, question: string) =>
    flag ?? (flagsOnly ? undefined : (await ask(question)) || undefined);
  if (!flagsOnly) {
    console.log([
      "",
      "Three optional keys. Each adds something once the site is on Cloudflare; press Enter to skip, and add it later with `pnpm trip:keys`.",
      "  Google Maps key        place photos, street maps, transit times outside Japan.",
      "                         A Google Cloud API key, on a project with billing on and these APIs enabled:",
      "                         Places API (New), Maps Static API, Routes API, Cloud Translation API.",
      "  Google project number  better English names for lines and towns. The number on the Cloud console's",
      "                         dashboard for the same project (digits, not the project id).",
      "  NAVITIME key           transit times in Japan. Your RapidAPI key, subscribed to NAVITIME's route API",
      "                         (navitime-route-totalnavi); the free plan is enough for one trip.",
      "",
    ].join("\n"));
  }
  const googleKey = await optional(values["google-key"], "Google Maps key: ");
  const googleProject = await optional(values["google-project"], "Google project number: ");
  const navitimeKey = await optional(values["navitime-key"], "NAVITIME key: ");

  let passphrase: string;
  try {
    ({ passphrase } = writeInitialConfig(configPath, { wanderlog: id, googleKey, googleProject, navitimeKey }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(`\nWrote ${shownConfig}.`);
  if (googleKey || navitimeKey) {
    console.log("\nTesting the keys (one small request to each API)…");
    console.log(formatKeyChecks(await checkKeys({ googleKey, googleProject, navitimeKey })));
    console.log("They are saved either way; a failed one does nothing until it works. To change one: `pnpm trip:keys`.");
  }

  if (values["no-pull"]) {
    console.log("Skipped the pull (--no-pull). Run `pnpm trip:pull`, then `pnpm build`.");
  } else {
    console.log("\nPulling the trip from Wanderlog…");
    const tsx = resolve(root, "node_modules/.bin/tsx");
    if ((await runAttached(tsx, ["scripts/refresh-trip.ts", "--config", configPath])) !== 0) {
      console.error(`\nThe pull failed. ${shownConfig} is written; fix the problem above and run \`pnpm trip:pull\`.`);
      process.exit(1);
    }
    console.log("\nBuilding the site…");
    if ((await runAttached("pnpm", ["build"])) !== 0) {
      console.error("\nThe build failed; see above. Run `pnpm build` again once it is fixed.");
      process.exit(1);
    }
  }

  console.log(`\nYour trip's passphrase: ${passphrase}`);
  console.log("Travellers type it once on each phone. Share it privately; it is also saved in the config.");
  if (!values["no-pull"]) console.log("The site is built in apps/web/dist/. Put it online from the menu below, or copy that folder to any static host.");
}

async function perform(action: Action): Promise<boolean> {
  if (action === "dev") {
    await runAttached("pnpm", ["dev"]);
  } else if (action === "mcp") {
    await runAttached(resolve(root, "node_modules/.bin/tsx"), ["scripts/mcp-local.ts", "--config", configPath]);
  } else if (action === "keys") {
    await runAttached(resolve(root, "node_modules/.bin/tsx"), ["scripts/keys.ts", "--config", configPath]);
  } else if (action === "deploy" || action === "connector") {
    const connectorOnly = action === "connector";
    const dryRun = values["dry-run"]!;
    const tokenEnv = values["api-token-env"];
    if (tokenEnv && !process.env[tokenEnv]) {
      console.error(`--api-token-env ${tokenEnv}: that environment variable is empty.`);
      return true;
    }
    const agreed = await setupCloudflare({
      root,
      configPath,
      dryRun,
      connectorOnly,
      project: values.project,
      base: values.path,
      domain: values.domain,
      apiToken: tokenEnv ? process.env[tokenEnv] : undefined,
      accountId: values.account,
      ask: interactive ? ask : undefined,
      askSecret: interactive ? askSecret : undefined,
      confirm: async (plan) => {
        console.log(`\nDeploy ${connectorOnly ? "the connector " : ""}to Cloudflare Pages${dryRun ? " (dry run: nothing is created, set or written)" : ""}. This will set up:`);
        for (const line of plan) console.log(`  - ${line}`);
        if (dryRun || values.yes) return true;
        return /^y(es)?$/i.test(await ask("Go ahead? [y/N] "));
      },
    }).catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      return false;
    });
    if (!agreed) {
      console.log("Nothing was deployed.");
    } else if (dryRun) {
      console.log(`would run pnpm ship${connectorOnly ? ", then print the connector link to paste into Claude or ChatGPT" : ""}\nDry run finished. Nothing was created, set, written or uploaded.`);
    } else if ((await runAttached("pnpm", ["ship"])) === 0) {
      const { config } = loadIngestionConfigSync(configPath);
      const site = `${config.site.origin ?? ""}${config.site.base}`;
      if (connectorOnly) {
        console.log("\nThe connector is online. Paste the link above into Claude or ChatGPT as a custom connector.");
      } else {
        console.log(`\nThe site is online at ${site}. Send travellers that address and the passphrase.`);
        console.log("Each traveller can give their own chat agent the trip with \"Copy connector link\" at the bottom of the app.");
      }
      console.log("From now on the site pulls plan changes from Wanderlog by itself. Run `pnpm ship` only after changing this code.");
    }
  } else {
    console.log("\nTo come back to any of this later:");
    for (const line of comeBack) console.log(line);
    return false;
  }
  return true;
}

if (values.action) {
  await perform(values.action as Action);
} else if (!interactive) {
  console.log("\nNo terminal for the menu. Next:");
  for (const line of comeBack) console.log(line);
} else {
  for (;;) {
    console.log([
      "",
      "What next?",
      "  1) Preview the site on this computer",
      "  2) Run the connector on this computer, for a chat agent here (Claude Code, Claude Desktop)",
      "  3) Put the site and the connector online (Cloudflare, free plan)",
      "  4) Put only the connector online, no site (Cloudflare, free plan)",
      "  5) Test or change the API keys",
      "  6) Quit",
    ].join("\n"));
    const choice = await ask("> ");
    const action = ({ "1": "dev", "2": "mcp", "3": "deploy", "4": "connector", "5": "keys", "6": "quit", q: "quit" } as Record<string, Action>)[choice];
    if (!action) continue;
    if (!(await perform(action))) break;
  }
}
rl?.close();
