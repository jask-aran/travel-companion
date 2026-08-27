import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { encryptTrip } from "../src/lib/trip-crypto";
import { parse as parseYaml } from "yaml";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(appDir, "../..");
const localConfigPath = resolve(projectRoot, "config/trip.local.yaml");

/**
 * How stale a bundle may be before `pnpm dev` re-pulls it in the background.
 * Wanderlog edits during a trip are frequent enough that a day is too long and
 * a minute would hammer the CLI on every restart.
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * `auto`   - refresh when missing, or (in dev) when stale. Default.
 * `always` - refresh on every dev start / build.
 * `never`  - no automatic refresh; build fails with manual instructions if the
 *            bundle is missing. Use this in CI, or on a plane. An explicit
 *            `/__trip/refresh` call still runs, since that is a user action.
 */
type RefreshMode = "auto" | "always" | "never";

function refreshMode(): RefreshMode {
  const raw = process.env.TRIP_REFRESH?.toLowerCase();
  return raw === "always" || raw === "never" ? raw : "auto";
}

export type LocalTripConfig = {
  workingBundle: string;
  googleApiKey: string;
  passphrase: string;
};

function readLocalConfig(): LocalTripConfig {
  if (!existsSync(localConfigPath)) {
    throw new Error(
      `Missing ${localConfigPath}. Copy config/trip.example.yaml to config/trip.local.yaml and set your Wanderlog trip id (gitignored).`,
    );
  }
  const raw = parseYaml(readFileSync(localConfigPath, "utf8")) as {
    paths?: { workingBundle?: string };
    google?: { apiKey?: string };
    share?: { passphrase?: string };
  };
  const relative = raw.paths?.workingBundle;
  if (!relative) {
    throw new Error("config/trip.local.yaml is missing paths.workingBundle");
  }
  return {
    workingBundle: resolve(projectRoot, relative),
    googleApiKey: raw.google?.apiKey ?? "",
    passphrase: raw.share?.passphrase ?? "",
  };
}

/**
 * The Google browser key, for injecting into the client build. Place Photos
 * may not be cached or re-hosted, so the browser must call Google directly.
 */
/**
 * Passphrase for the published payload. Empty means publish plaintext, which
 * is only appropriate when the site itself is access-controlled.
 */
export function localPassphrase(): string {
  if (process.env.TRIP_PASSPHRASE) return process.env.TRIP_PASSPHRASE;
  try {
    return readLocalConfig().passphrase;
  } catch {
    return "";
  }
}

export function localGoogleApiKey(): string {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  try {
    return readLocalConfig().googleApiKey;
  } catch {
    return "";
  }
}

/**
 * Run scripts/refresh-trip.ts (Wanderlog CLI, with the browser scraper as
 * fallback). Spawns the local tsx binary directly rather than going through
 * pnpm so the child inherits our stdio cleanly and there is no extra process.
 */
function runRefresh(source: "auto" | "cli" | "html"): Promise<void> {
  const tsx = resolve(projectRoot, "node_modules/.bin/tsx");
  if (!existsSync(tsx)) {
    return Promise.reject(new Error(`tsx not found at ${tsx} — run pnpm install`));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(tsx, ["scripts/refresh-trip.ts", "--source", source], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`refresh-trip.ts exited with code ${code}`));
    });
  });
}

export function tripBundlePlugin(): Plugin {
  let workingBundle = "";
  let inFlight: Promise<void> | null = null;
  let server: ViteDevServer | undefined;

  /** Collapse concurrent triggers (startup + endpoint) into one CLI run. */
  const refreshOnce = (source: "auto" | "cli" | "html" = "auto"): Promise<void> => {
    inFlight ??= runRefresh(source).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const isStale = (): boolean => {
    try {
      return Date.now() - statSync(workingBundle).mtimeMs > STALE_AFTER_MS;
    } catch {
      return true;
    }
  };

  const ageLabel = (): string => {
    const hours = (Date.now() - statSync(workingBundle).mtimeMs) / 3_600_000;
    return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(1)}h`;
  };

  return {
    name: "trip-bundle",

    configResolved() {
      workingBundle = readLocalConfig().workingBundle;
    },

    async buildStart() {
      // Dev handles its own (non-blocking) refresh in configureServer.
      if (server) return;
      const mode = refreshMode();
      if (mode === "never") return;
      if (mode === "always" || !existsSync(workingBundle)) {
        this.info(
          existsSync(workingBundle)
            ? "TRIP_REFRESH=always — pulling latest trip from Wanderlog"
            : "No trip bundle yet — pulling from Wanderlog",
        );
        await refreshOnce();
      }
    },

    configureServer(devServer) {
      server = devServer;
      const mode = refreshMode();
      const log = devServer.config.logger;

      // Never block dev server startup on the network: the page can boot from
      // whatever bundle is on disk while the refresh runs behind it.
      const kick = (reason: string) => {
        log.info(`  ➜  trip:  ${reason} — refreshing from Wanderlog…`);
        refreshOnce()
          .then(() => log.info("  ➜  trip:  bundle updated"))
          .catch((error: unknown) => {
            log.warn(
              `  ➜  trip:  refresh failed (${error instanceof Error ? error.message : String(error)}). Serving the existing bundle.`,
            );
          });
      };

      if (mode === "always") kick("TRIP_REFRESH=always");
      else if (mode === "auto" && !existsSync(workingBundle)) kick("no bundle on disk");
      else if (mode === "auto" && isStale()) kick(`bundle is ${ageLabel()} old`);

      // A finished refresh rewrites working.json outside Vite's module graph,
      // so watch it explicitly and push a reload when new content lands.
      devServer.watcher.add(workingBundle);
      devServer.watcher.on("change", (file) => {
        if (resolve(file) !== workingBundle) return;
        log.info("  ➜  trip:  bundle changed — reloading clients");
        devServer.ws.send({ type: "full-reload" });
      });

      devServer.middlewares.use((req, res, next) => {
        const path = req.url?.split("?")[0];

        // Dev-only hook so a refresh can be triggered without leaving the app.
        if (path === "/__trip/refresh") {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          refreshOnce().then(
            () => res.end(JSON.stringify({ ok: true })),
            (error: unknown) => {
              res.statusCode = 502;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                }),
              );
            },
          );
          return;
        }

        if (path !== "/trip.json") {
          next();
          return;
        }

        try {
          if (!existsSync(workingBundle)) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify(
                {
                  error: "TripBundle not generated yet",
                  workingBundle,
                  hint: "A refresh may still be running — check the dev server output. Otherwise run `pnpm trip:refresh`.",
                },
                null,
                2,
              ),
            );
            return;
          }
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.statusCode = 200;
          res.end(readFileSync(workingBundle, "utf8"));
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    },

    async writeBundle(outputOptions) {
      const outDir = outputOptions.dir ?? resolve(appDir, "dist");
      if (!existsSync(workingBundle)) {
        throw new Error(
          `Cannot build the PWA without a trip bundle at ${workingBundle}.\n` +
            "Run `pnpm trip:refresh`, or unset TRIP_REFRESH=never to let the build pull it.",
        );
      }
      const body = readFileSync(workingBundle, "utf8");
      mkdirSync(outDir, { recursive: true });

      const passphrase = localPassphrase();
      if (passphrase) {
        // Publish ciphertext only: the plaintext must never reach the host.
        const encrypted = await encryptTrip(body, passphrase);
        writeFileSync(resolve(outDir, "trip.enc"), `${JSON.stringify(encrypted)}\n`, "utf8");
      } else {
        writeFileSync(
          resolve(outDir, "trip.json"),
          body.endsWith("\n") ? body : `${body}\n`,
          "utf8",
        );
      }
    },
  };
}
