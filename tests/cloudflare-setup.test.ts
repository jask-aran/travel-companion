import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { setupCloudflare, type Wrangler } from "../scripts/cloudflare-setup.js";
import { wranglerConfig } from "../scripts/wrangler-config.js";
import { loadIngestionConfigSync, siteSettings } from "../packages/wanderlog-import/src/config.js";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(yaml = "trip:\n  wanderlogId: abc123\nshare:\n  passphrase: pass\n") {
  const root = mkdtempSync(join(tmpdir(), "cf-setup-"));
  temporary.push(root);
  mkdirSync(join(root, "config"));
  const configPath = join(root, "config/trip.local.yaml");
  writeFileSync(configPath, yaml);
  return { root, configPath };
}

const GOOD = "tok-good";
const ACCOUNTS = [{ id: "acc1", name: "One" }, { id: "acc2", name: "Two" }];

/** Answers like wrangler: whoami works with the good token (or a browser login), lists start empty. */
function fakeWrangler(options: { browserLogin?: boolean; accounts?: typeof ACCOUNTS } = {}) {
  const calls: { args: string[]; token?: string | undefined; account?: string | undefined; input?: string | undefined }[] = [];
  const namespaces: { id: string; title: string }[] = [];
  const wrangler: Wrangler = (args, { env, input }) => {
    calls.push({ args, token: env.CLOUDFLARE_API_TOKEN, account: env.CLOUDFLARE_ACCOUNT_ID, input });
    const out = (stdout: string, status = 0) => ({ status, stdout, stderr: "" });
    const key = args.slice(0, 3).join(" ");
    if (args[0] === "whoami") {
      const ok = env.CLOUDFLARE_API_TOKEN === GOOD || (!env.CLOUDFLARE_API_TOKEN && options.browserLogin);
      return ok
        ? out(JSON.stringify({ loggedIn: true, authType: env.CLOUDFLARE_API_TOKEN ? "User API Token" : "OAuth Token", accounts: options.accounts ?? ACCOUNTS.slice(0, 1) }))
        : { status: 1, stdout: "", stderr: "✘ [ERROR] Invalid request headers [code: 6003]" };
    }
    if (key === "kv namespace list") return out(JSON.stringify(namespaces));
    if (key === "kv namespace create") namespaces.push({ id: "kv-new", title: args[3]! });
    if (key === "pages project list") return out("[]");
    return out("");
  };
  return { wrangler, calls };
}

describe("Cloudflare setup", () => {
  it("dry run asks Cloudflare nothing, masks the token and plans path and domain", async () => {
    const { root, configPath } = scratch();
    const { wrangler, calls } = fakeWrangler();
    const lines: string[] = [];
    let plan: string[] = [];
    const agreed = await setupCloudflare({
      root, configPath, dryRun: true, base: "japan", domain: "Trip.Example.com", apiToken: "secret-token", accountId: "acc1",
      wrangler, log: (line) => lines.push(line), confirm: async (given) => ((plan = given), true),
    });
    expect(agreed).toBe(true);
    expect(calls).toEqual([]);
    expect(plan.join("\n")).toContain("Served at https://trip.example.com/japan/");
    expect(plan.join("\n")).toContain("KV namespace travel-companion-trip ");
    const output = [...plan, ...lines].join("\n");
    expect(output).not.toContain("secret-token");
    expect(lines).toContain("would set cloudflare.apiToken: ********");
    expect(lines).toContain("would set site.base: /japan/");
    expect(lines).toContain('would POST https://api.cloudflare.com/client/v4/accounts/acc1/pages/projects/travel-companion-trip/domains {"name":"trip.example.com"}');
    expect(readFileSync(configPath, "utf8")).not.toContain("cloudflare");
  });

  it("without a login or a terminal, stops before the plan with the token instructions", async () => {
    const { root, configPath } = scratch();
    const { wrangler } = fakeWrangler();
    const confirm = async () => true;
    await expect(setupCloudflare({ root, configPath, dryRun: false, wrangler, confirm, log: () => {} }))
      .rejects.toThrow(/Nobody is logged in[\s\S]*Cloudflare Pages > Edit/);
  });

  it("takes a pasted token, gives it to every wrangler in the environment, stores it and attaches the domain", async () => {
    const { root, configPath } = scratch();
    const { wrangler, calls } = fakeWrangler();
    const requests: { url: string; init: RequestInit }[] = [];
    // The project name (Enter: the suggested one), "paste a token" twice (the first is bad), path, domain.
    const answers = ["", "2", "2", "", "trip.example.com"];
    const secretAnswers = ["tok-bad", GOOD];
    const lines: string[] = [];
    const agreed = await setupCloudflare({
      root, configPath, dryRun: false, wrangler, log: (line) => lines.push(line),
      ask: async () => answers.shift() ?? "2",
      askSecret: async () => secretAnswers.shift()!,
      confirm: async () => true,
      fetch: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response(JSON.stringify({ success: true }));
      }) as typeof fetch,
    });
    expect(agreed).toBe(true);
    expect(lines.join("\n")).toContain("That token did not work: ✘ [ERROR] Invalid request headers");
    const afterLogin = calls.slice(calls.findIndex((call) => call.token === GOOD) + 1);
    for (const call of afterLogin) {
      expect(call.token).toBe(GOOD);
      expect(call.account).toBe("acc1");
      expect(call.args.join(" ")).not.toContain(GOOD);
    }
    expect(calls.some((call) => call.args.join(" ") === "kv namespace create travel-companion-trip")).toBe(true);
    const written = parseYaml(readFileSync(configPath, "utf8"));
    expect(written.cloudflare).toEqual({ project: "travel-companion-trip", kvNamespaceId: "kv-new", accountId: "acc1", apiToken: GOOD });
    expect(written.site).toEqual({ origin: "https://trip.example.com" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc1/pages/projects/travel-companion-trip/domains");
    expect(lines.join("\n")).toContain("CNAME trip.example.com -> travel-companion-trip.pages.dev");
    expect(lines.join("\n")).not.toContain(GOOD);
  });

  it("with a browser login and several accounts, needs --account without a terminal, and prints the domain steps", async () => {
    const { root, configPath } = scratch();
    const { wrangler } = fakeWrangler({ browserLogin: true, accounts: ACCOUNTS });
    const confirm = async () => true;
    await expect(setupCloudflare({ root, configPath, dryRun: false, wrangler, confirm, log: () => {} }))
      .rejects.toThrow(/2 accounts; choose one with --account/);

    const lines: string[] = [];
    const { wrangler: second, calls } = fakeWrangler({ browserLogin: true, accounts: ACCOUNTS });
    await setupCloudflare({ root, configPath, dryRun: false, wrangler: second, confirm, accountId: "acc2", domain: "trip.example.com", log: (line) => lines.push(line) });
    expect(calls.filter((call) => call.args[0] !== "whoami").every((call) => call.account === "acc2" && !call.token)).toBe(true);
    expect(lines.join("\n")).toContain("Add the custom domain by hand");
  });

  it("keeps a namespace id already in the config", async () => {
    const { root, configPath } = scratch("trip:\n  wanderlogId: abc123\ncloudflare:\n  project: mine\n  kvNamespaceId: kv-old\n");
    const { wrangler, calls } = fakeWrangler({ browserLogin: true });
    await setupCloudflare({ root, configPath, dryRun: false, wrangler, confirm: async () => true, base: "/", log: () => {} });
    expect(calls.some((call) => call.args[0] === "kv")).toBe(false);
    expect(parseYaml(readFileSync(configPath, "utf8")).cloudflare.kvNamespaceId).toBe("kv-old");
  });

  it("connector only: asks only its name, no bucket, served at pages.dev, recorded for ship", async () => {
    const { root, configPath } = scratch("trip:\n  wanderlogId: abc123\nshare:\n  passphrase: pass\ngoogle:\n  apiKey: g\nsite:\n  base: /japan/\n");
    const { wrangler, calls } = fakeWrangler({ browserLogin: true });
    const asked: string[] = [];
    await setupCloudflare({
      root, configPath, dryRun: false, connectorOnly: true, wrangler, confirm: async () => true, log: () => {},
      ask: async (question) => (asked.push(question), ""), askSecret: async () => "",
    });
    expect(asked).toEqual([expect.stringContaining("Name for the Cloudflare project")]);
    expect(calls.some((call) => call.args[0] === "r2")).toBe(false);
    expect(calls.some((call) => call.args.join(" ") === "pages secret put TRIP_PASSPHRASE --project-name travel-companion-trip")).toBe(true);
    const written = parseYaml(readFileSync(configPath, "utf8"));
    expect(written.cloudflare.connectorOnly).toBe(true);
    expect(written.site).toEqual({ base: "/", origin: "https://travel-companion-trip.pages.dev" });
    expect(loadIngestionConfigSync(configPath).config.cloudflare?.connectorOnly).toBe(true);
    // The function still needs its KV binding.
    expect(wranglerConfig(siteSettings(loadIngestionConfigSync(configPath).config))).toHaveProperty("kv_namespaces");
  });

  it("connector only needs a passphrase for the link", async () => {
    const { root, configPath } = scratch("trip:\n  wanderlogId: abc123\n");
    await expect(setupCloudflare({ root, configPath, dryRun: true, connectorOnly: true, confirm: async () => true, log: () => {} }))
      .rejects.toThrow(/share.passphrase/);
  });
});
