import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { loadIngestionConfigSync, normaliseBase, siteSettings } from "../packages/wanderlog-import/src/config.js";
import { writeWranglerConfig } from "./wrangler-config.js";

/**
 * Checks who is logged in to Cloudflare (browser login or API token), then
 * provisions the Pages project, KV namespace and R2 bucket (reusing any that
 * exist), writes their ids to the config and wrangler.jsonc, sets the
 * function's secrets on stdin, and attaches a custom domain if one is given.
 * The token and account go to wrangler in its environment, never in argv.
 * `dryRun` asks Cloudflare nothing, so it shows every create.
 * `connectorOnly` is the hosted connector without the app: no R2 bucket, no
 * path or domain, served at https://<project>.pages.dev/.
 */
export interface CloudflareSetupOptions {
  root: string;
  configPath: string;
  dryRun: boolean;
  /** Pages project name; default the config's, else travel-companion-<publicId>. */
  project?: string | undefined;
  /** Path the site is served under; default the config's site.base. */
  base?: string | undefined;
  /** Custom domain, e.g. trip.example.com; none serves at <project>.pages.dev. */
  domain?: string | undefined;
  /** Only the connector, no app: recorded as cloudflare.connectorOnly for `pnpm ship`. */
  connectorOnly?: boolean | undefined;
  /** API token; default the config's cloudflare.apiToken, else the browser login. */
  apiToken?: string | undefined;
  /** Account id; default the config's, else the login's only account, else asked. */
  accountId?: string | undefined;
  /** Shown the plan before anything changes on Cloudflare; false stops. */
  confirm(plan: string[]): Promise<boolean>;
  /** Questions for the login step; without them a missing login is an error. */
  ask?: ((question: string) => Promise<string>) | undefined;
  askSecret?: ((question: string) => Promise<string>) | undefined;
  log?: (line: string) => void;
  /** Seams for tests. */
  wrangler?: Wrangler;
  fetch?: typeof fetch;
}

export interface WranglerResult { status: number | null; stdout: string; stderr: string }
/** `quiet` captures stderr too; `capture` captures stdout; `input` is piped to stdin. */
export type Wrangler = (
  args: string[],
  options: { env: NodeJS.ProcessEnv; capture?: boolean | undefined; quiet?: boolean | undefined; input?: string | undefined },
) => WranglerResult;

export function spawnWrangler(root: string): Wrangler {
  const bin = resolve(root, "node_modules/.bin/wrangler");
  return (args, { env, capture, quiet, input }) => {
    const result = spawnSync(bin, args, {
      cwd: root,
      env,
      input,
      encoding: "utf8",
      stdio: [input !== undefined ? "pipe" : "inherit", capture || quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

interface Login { authType: string; accounts: { id: string; name: string }[] }

/** `wrangler whoami --json`: undefined, with wrangler's reason, when nobody is logged in. */
export function whoami(wrangler: Wrangler, env: NodeJS.ProcessEnv): Login | { reason: string } {
  const result = wrangler(["whoami", "--json"], { env, quiet: true });
  const start = result.stdout.indexOf("{");
  if (result.status === 0 && start >= 0) {
    const parsed = JSON.parse(result.stdout.slice(start)) as Partial<Login> & { loggedIn?: boolean };
    if (parsed.loggedIn) return { authType: parsed.authType ?? "login", accounts: parsed.accounts ?? [] };
  }
  // eslint-disable-next-line no-control-regex
  const lines = result.stderr.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((line) => line.trim());
  const reason = lines.filter((line) => line && !line.startsWith("🪵") && !line.startsWith("If you think")).slice(0, 3).join(" ");
  return { reason: reason || "nobody is logged in" };
}

export const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const TOKEN_HELP = [
  `Create a token at ${TOKEN_URL}: Create Token, then "Create Custom Token". Give it these permissions:`,
  "  Account > Cloudflare Pages > Edit         (project, deploys, secrets, custom domain)",
  "  Account > Workers KV Storage > Edit       (the trip namespace)",
  "  Account > Workers R2 Storage > Edit       (the photo bucket; only with a Google key)",
  "  Account > Account Settings > Read         (lets wrangler find your account)",
  "  User > User Details > Read                (optional: lets `wrangler whoami` show your email)",
  "Account Resources: the account to deploy to. Then Continue to summary, Create Token, and copy it.",
];

const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Returns false if the user said no. Throws if a wrangler step fails. */
export async function setupCloudflare(options: CloudflareSetupOptions): Promise<boolean> {
  const log = options.log ?? console.log;
  const { dryRun, root, configPath, ask, askSecret } = options;
  const { config } = loadIngestionConfigSync(configPath);
  const wrangler = options.wrangler ?? spawnWrangler(root);

  const suggested = `travel-companion-${config.trip.publicId}`;
  const project = options.project ?? config.cloudflare?.project
    ?? (((ask && (await ask(`Name for the Cloudflare project; it is also the address, <name>.pages.dev [${suggested}]: `))) || suggested).toLowerCase());
  if (!PROJECT_NAME.test(project)) {
    throw new Error(`"${project}" is not a valid Pages project name (lowercase letters, digits and dashes).`);
  }
  // Titled after the project; older setups used <project>-trip, which is still found.
  const kvTitle = project;
  const connectorOnly = Boolean(options.connectorOnly);
  if (connectorOnly && !config.share?.passphrase) {
    throw new Error("The connector link is made from share.passphrase, and the config has none. Set one, then try again.");
  }
  const wantMedia = !connectorOnly && Boolean(config.google?.apiKey);
  const secrets: [string, string | undefined][] = [
    ["WANDERLOG_TRIP_ID", config.trip.wanderlogId],
    ["TRIP_PASSPHRASE", config.share?.passphrase],
    ["GOOGLE_MAPS_API_KEY", config.google?.apiKey],
    ["NAVITIME_API_KEY", config.navitime?.apiKey],
    ["GOOGLE_PROJECT_NUMBER", config.google?.projectNumber?.toString()],
  ];

  // 0. Who is logged in. A dry run contacts nothing, so it only says what it would use.
  let apiToken = options.apiToken ?? config.cloudflare?.apiToken;
  let accountId = options.accountId ?? config.cloudflare?.accountId;
  const envFor = (token = apiToken, account = accountId): NodeJS.ProcessEnv => ({
    ...process.env,
    ...(token ? { CLOUDFLARE_API_TOKEN: token } : {}),
    ...(account ? { CLOUDFLARE_ACCOUNT_ID: account } : {}),
  });
  let accountLine: string;
  if (dryRun) {
    accountLine = `${apiToken ? "API token ********" : "the browser login (`wrangler login`)"}, account ${accountId ?? "checked when run for real"}`;
  } else {
    let login = whoami(wrangler, envFor());
    if ("reason" in login && apiToken) log(`The API token did not work: ${login.reason}`);
    while ("reason" in login) {
      if (!ask || !askSecret) {
        throw new Error(
          `Nobody is logged in to Cloudflare (${login.reason}). Run \`pnpm exec wrangler login\`, or pass --api-token-env <NAME> with a token in that variable.\n${TOKEN_HELP.join("\n")}`,
        );
      }
      log("\nNobody is logged in to Cloudflare.\n  1) Log in with the browser (wrangler login)\n  2) Paste an API token\n  3) Stop");
      const choice = await ask("> ");
      if (choice === "1") {
        apiToken = undefined;
        wrangler(["login"], { env: envFor(undefined) });
        login = whoami(wrangler, envFor(undefined));
      } else if (choice === "2") {
        log(TOKEN_HELP.join("\n"));
        const token = await askSecret("API token (hidden): ");
        if (!token) continue;
        login = whoami(wrangler, envFor(token));
        if ("reason" in login) log(`That token did not work: ${login.reason}`);
        else apiToken = token;
      } else if (choice === "3" || choice === "q") {
        return false;
      }
    }
    const accounts = login.accounts;
    if (accountId && accounts.length && !accounts.some((account) => account.id === accountId)) {
      throw new Error(`This login cannot see account ${accountId}. Its accounts: ${accounts.map((a) => a.name).join(", ")}.`);
    }
    if (!accountId && accounts.length === 1) accountId = accounts[0]!.id;
    while (!accountId && accounts.length > 1) {
      if (!ask) throw new Error(`This login has ${accounts.length} accounts; choose one with --account <id>:\n${accounts.map((a) => `  ${a.name}: ${a.id}`).join("\n")}`);
      log(`\nThis login has ${accounts.length} accounts:`);
      accounts.forEach((account, index) => log(`  ${index + 1}) ${account.name}`));
      accountId = accounts[Number(await ask("Which one? ")) - 1]?.id;
    }
    const name = accounts.find((account) => account.id === accountId)?.name ?? accountId ?? "unknown";
    log(`Logged in to Cloudflare (${login.authType}), account ${name}.`);
    accountLine = `${apiToken ? "API token" : "browser login"}, account ${name}`;

    // A token's permissions cannot be read back, so try what the deploy needs.
    if (apiToken) {
      const probes: [string[], string][] = [
        [["pages", "project", "list", "--json"], "Account > Cloudflare Pages > Edit"],
        [["kv", "namespace", "list"], "Account > Workers KV Storage > Edit"],
        ...(wantMedia ? [[["r2", "bucket", "list"], "Account > Workers R2 Storage > Edit (and R2 enabled on the account)"] as [string[], string]] : []),
      ];
      const missing = probes.filter(([args]) => wrangler(args, { env: envFor(), quiet: true }).status !== 0).map(([, need]) => need);
      if (missing.length) throw new Error(`The API token cannot list what the deploy needs. Add to the token:\n  ${missing.join("\n  ")}`);
    }
  }
  const env = envFor();

  // Where it is served. Asked only when there is a terminal and no flag; a connector has no choice.
  const base = connectorOnly ? "/" : normaliseBase(
    options.base ?? ((ask && (await ask(`Path to serve the site under [${config.site.base}]: `))) || config.site.base),
  );
  const domainAnswer = connectorOnly ? "" : options.domain ?? (ask ? await ask(`Custom domain, e.g. trip.example.com (Enter for ${project}.pages.dev): `) : "");
  const domain = domainAnswer.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") || undefined;
  if (domain && !DOMAIN.test(domain)) throw new Error(`"${domain}" is not a domain name like trip.example.com.`);
  const pagesDev = `https://${project}.pages.dev`;
  const origin = domain ? `https://${domain}` : connectorOnly ? pagesDev : (config.site.origin ?? pagesDev);

  const setting = secrets.filter(([, value]) => value).map(([name]) => name);
  const plan = [
    `Cloudflare: ${accountLine}`,
    `Pages project ${project} (created unless your account has it)`,
    `Served at ${origin}${base}${domain ? ` (custom domain ${domain}, on top of https://${project}.pages.dev)` : ""}`,
    config.cloudflare?.kvNamespaceId
      ? "KV namespace: the one already in the config"
      : `KV namespace ${kvTitle} (created unless your account has it)`,
    connectorOnly
      ? "No R2 bucket and no app: only the connector"
      : config.cloudflare?.mediaBucket
      ? "R2 bucket: the one already in the config"
      : wantMedia
        ? `R2 bucket ${project}-media for photos and maps (created unless your account has it)`
        : "No R2 bucket: there is no Google key, so photos and maps stay off",
    `Stored as secrets on the project (never in the site): ${setting.join(", ")}`,
    `Then: save the Cloudflare details in ${configPath.replace(`${root}/`, "")} and deploy (pnpm ship)${connectorOnly ? ", the connector only" : ""}`,
  ];
  if (!(await options.confirm(plan))) return false;

  const run = (args: string[], step: { capture?: boolean; secretStdin?: string; allowFail?: boolean } = {}) => {
    const printed = `${step.secretStdin !== undefined ? "printf '********' | " : ""}wrangler ${args.join(" ")}`;
    log(`${dryRun ? "would run" : "▸"} ${printed}`);
    if (dryRun) return { ok: true, stdout: "" };
    const result = wrangler(args, { env, capture: step.capture, input: step.secretStdin });
    const ok = result.status === 0;
    if (!ok && !step.allowFail) {
      throw new Error(`wrangler ${args.join(" ")} failed (exit ${result.status ?? "signal"}). Nothing after it ran; fix it and choose deploy again.`);
    }
    return { ok, stdout: result.stdout };
  };
  /** The JSON a list command printed (wrangler may print a banner before it). */
  const json = <T>(stdout: string): T => {
    const start = stdout.search(/[[{]/);
    return JSON.parse(start >= 0 ? stdout.slice(start) : "[]") as T;
  };

  // 1. Pages project.
  const projects = json<{ "Project Name": string }[]>(run(["pages", "project", "list", "--json"], { capture: true }).stdout);
  if (projects.some((entry) => entry["Project Name"] === project)) log(`  Pages project ${project} exists.`);
  else run(["pages", "project", "create", project, "--production-branch", "main"]);

  // 2. KV namespace.
  let kvNamespaceId = config.cloudflare?.kvNamespaceId;
  if (!kvNamespaceId) {
    const find = () => {
      const namespaces = json<{ id: string; title: string }[]>(run(["kv", "namespace", "list"], { capture: true }).stdout);
      return [kvTitle, `${project}-trip`].map((title) => namespaces.find((namespace) => namespace.title === title)?.id).find(Boolean);
    };
    kvNamespaceId = find();
    if (!kvNamespaceId) {
      run(["kv", "namespace", "create", kvTitle]);
      kvNamespaceId = dryRun ? "<new namespace id>" : find();
      if (!kvNamespaceId) throw new Error(`Created KV namespace ${kvTitle} but could not find its id in \`wrangler kv namespace list\`.`);
    }
  }

  // 3. R2 bucket.
  let mediaBucket = config.cloudflare?.mediaBucket;
  if (!mediaBucket && wantMedia) {
    mediaBucket = `${project}-media`;
    const exists = run(["r2", "bucket", "info", mediaBucket, "--json"], { capture: true, allowFail: true }).ok;
    if (dryRun || !exists) run(["r2", "bucket", "create", mediaBucket]);
  }

  // 4. Config and wrangler.jsonc.
  const entries: [string[], string | boolean, boolean?][] = [
    [["cloudflare", "project"], project],
    [["cloudflare", "kvNamespaceId"], kvNamespaceId],
  ];
  if (connectorOnly) entries.push([["cloudflare", "connectorOnly"], true]);
  if (mediaBucket) entries.push([["cloudflare", "mediaBucket"], mediaBucket]);
  if (accountId) entries.push([["cloudflare", "accountId"], accountId]);
  if (apiToken) entries.push([["cloudflare", "apiToken"], apiToken, true]);
  if (base !== config.site.base) entries.push([["site", "base"], base]);
  if (origin !== config.site.origin) entries.push([["site", "origin"], origin]);
  if (dryRun) {
    for (const [path, value, secret] of entries) log(`would set ${path.join(".")}: ${secret ? "********" : value}`);
    log("would write wrangler.jsonc");
  } else {
    const document = parseDocument(readFileSync(configPath, "utf8"));
    for (const [path, value] of entries) document.setIn(path, value);
    writeFileSync(configPath, document.toString(), "utf8");
    log(`  Wrote ${entries.map(([path]) => path.join(".")).join(", ")} to the config.`);
    writeWranglerConfig(root, siteSettings(loadIngestionConfigSync(configPath).config));
    log("  Wrote wrangler.jsonc.");
  }

  // 5. Secrets, on stdin.
  for (const [name, value] of secrets) {
    if (value) run(["pages", "secret", "put", name, "--project-name", project], { secretStdin: value });
  }

  // 6. Custom domain. Wrangler has no command for it; the API needs a token.
  if (domain) await attachDomain({ domain, project, accountId, apiToken, dryRun, log, fetch: options.fetch ?? fetch });
  return true;
}

async function attachDomain(step: {
  domain: string; project: string; accountId: string | undefined; apiToken: string | undefined;
  dryRun: boolean; log: (line: string) => void; fetch: typeof fetch;
}): Promise<void> {
  const { domain, project, accountId, apiToken, dryRun, log } = step;
  const record = `  DNS: CNAME ${domain} -> ${project}.pages.dev`;
  const byHand = [
    `Add the custom domain by hand: dash.cloudflare.com > Workers & Pages > ${project} > Custom domains > Set up a domain > ${domain}.`,
    "If the domain's DNS is on Cloudflare in this account, Cloudflare adds the record when you confirm there.",
    "If it is elsewhere, add this record at your DNS provider after the step above (before it, the site shows a 522 error):",
    record,
    "A bare domain (example.com, not trip.example.com) has to be a zone on Cloudflare.",
  ];
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId ?? "<account id>"}/pages/projects/${project}/domains`;
  if (dryRun) {
    log(apiToken ? `would POST ${url} {"name":"${domain}"}` : "would print the custom-domain steps (no API token)");
    return;
  }
  if (!apiToken || !accountId) {
    for (const line of byHand) log(line);
    return;
  }
  log(`▸ attach ${domain} to ${project}`);
  const response = await step.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: domain }),
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; errors?: { message?: string }[] };
  const message = body.errors?.map((error) => error.message).join("; ") ?? "";
  if (response.ok && body.success !== false) {
    log(`  Attached ${domain}. If its DNS is not on Cloudflare in this account, add this record at your DNS provider:`);
    log(record);
    log("  Check it at dash.cloudflare.com > Workers & Pages > the project > Custom domains; it can take a few minutes to go Active.");
  } else if (/already/i.test(message)) {
    log(`  ${domain} is already attached to ${project}.`);
  } else {
    log(`  Could not attach ${domain} (HTTP ${response.status}${message ? `: ${message}` : ""}).`);
    for (const line of byHand) log(`  ${line}`);
  }
}
