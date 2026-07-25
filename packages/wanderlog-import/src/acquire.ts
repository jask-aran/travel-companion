import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import type { IngestionConfig } from "./config.js";
import { parseWanderlogSource } from "./index.js";

export type AcquisitionSource = "cli" | "html";

export interface AcquiredSource {
  source: AcquisitionSource;
  contents: string;
  diagnostics: string[];
}

export interface BrowserAcquisitionOptions {
  headless?: boolean;
}

function commandFailure(command: string, stderr: string, code: number | null): Error {
  const detail = stderr.trim() || `process exited with code ${String(code)}`;
  return new Error(`${command} failed: ${detail}`);
}

export async function acquireWithCli(config: IngestionConfig): Promise<AcquiredSource> {
  const command = config.wanderlog.cli.command;
  const args = ["trips", "show", config.trip.wanderlogId, "--output", "json"];

  return await new Promise<AcquiredSource>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${config.wanderlog.cli.timeoutMs} ms`));
    }, config.wanderlog.cli.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Unable to start ${command}: ${error.message}`, { cause: error }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(commandFailure(command, errorOutput, code));
        return;
      }

      try {
        const parsed = parseWanderlogSource(output);
        if (parsed.kind !== "cli-json") throw new Error("CLI returned a non-JSON source");
        resolve({
          source: "cli",
          contents: output,
          diagnostics: [`Ran ${command} ${args.join(" ")}`],
        });
      } catch (error) {
        reject(new Error(`${command} returned invalid Wanderlog JSON`, { cause: error }));
      }
    });
  });
}

export async function acquireWithBrowser(
  config: IngestionConfig,
  profileDirectory: string,
  options: BrowserAcquisitionOptions = {},
): Promise<AcquiredSource> {
  await mkdir(dirname(profileDirectory), { recursive: true });
  await mkdir(profileDirectory, { recursive: true });

  const headless = options.headless ?? config.wanderlog.web.headless;
  const context = await chromium.launchPersistentContext(profileDirectory, {
    headless,
    viewport: { width: 1440, height: 1000 },
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(config.wanderlog.web.url, {
      waitUntil: "domcontentloaded",
      timeout: config.wanderlog.web.timeoutMs,
    });

    await page.waitForFunction(
      () => Boolean((window as typeof window & { __MOBX_STATE__?: unknown }).__MOBX_STATE__),
      undefined,
      { timeout: config.wanderlog.web.timeoutMs },
    );

    await page.waitForFunction(
      () => {
        const state = (window as typeof window & {
          __MOBX_STATE__?: { tripPlanStore?: { data?: { tripPlan?: unknown } } };
        }).__MOBX_STATE__;
        return Boolean(state?.tripPlanStore?.data?.tripPlan);
      },
      undefined,
      { timeout: config.wanderlog.web.timeoutMs },
    );

    const html = await page.content();
    const parsed = parseWanderlogSource(html);
    if (parsed.kind !== "html-mobx") throw new Error("Scraped page did not contain Wanderlog MobX state");

    return {
      source: "html",
      contents: html,
      diagnostics: [
        `Scraped ${config.wanderlog.web.url}`,
        `Browser mode: ${headless ? "headless" : "headed"}`,
      ],
    };
  } finally {
    await context.close();
  }
}
