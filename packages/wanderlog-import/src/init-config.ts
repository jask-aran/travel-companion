import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { parseIngestionConfig, parseWanderlogId } from "./config.js";

/** What `pnpm trip:init` was given. Only the Wanderlog id is required. */
export interface InitOptions {
  wanderlog: string;
  googleKey?: string | undefined;
  googleProject?: string | undefined;
  navitimeKey?: string | undefined;
  publicId?: string | undefined;
  passphrase?: string | undefined;
}

/** No 0/o, 1/l/i: it gets read aloud and typed on phones. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 24 random characters in dashed groups of four: about 119 bits. */
export function generatePassphrase(): string {
  const groups = Array.from({ length: 6 }, () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
  );
  return groups.join("-");
}

/** The YAML for a new config/trip.local.yaml: the id, the passphrase, and only the keys given. */
function initConfigText(options: InitOptions, passphrase: string): string {
  const wanderlogId = parseWanderlogId(options.wanderlog);
  if (!wanderlogId) throw new Error("Give a Wanderlog plan URL or trip id.");
  const document: Record<string, unknown> = {
    trip: { wanderlogId, ...(options.publicId ? { publicId: options.publicId } : {}) },
    share: { passphrase },
  };
  if (options.googleKey || options.googleProject) {
    document.google = {
      ...(options.googleKey ? { apiKey: options.googleKey } : {}),
      ...(options.googleProject ? { projectNumber: String(options.googleProject) } : {}),
    };
  }
  if (options.navitimeKey) document.navitime = { apiKey: options.navitimeKey };

  // Fail here, not on the first pull, if something given is malformed.
  parseIngestionConfig(document);

  return [
    "# Written by `pnpm trip:init`. Gitignored: it holds the trip passphrase and any API keys.",
    "# config/trip.example.yaml lists every optional key (site, cloudflare, paths, ...).",
    stringify(document).trimEnd(),
    "",
  ].join("\n");
}

/**
 * Write a new config file. Refuses to touch an existing one. Returns the
 * passphrase written (generated unless one was given).
 */
export function writeInitialConfig(path: string, options: InitOptions): { passphrase: string; generated: boolean } {
  if (existsSync(path)) {
    throw new Error(`${path} already exists. trip:init only writes a new config; edit that one, or move it aside first.`);
  }
  const generated = !options.passphrase;
  const passphrase = options.passphrase || generatePassphrase();
  const text = initConfigText(options, passphrase);
  mkdirSync(dirname(path), { recursive: true });
  // "wx" fails if the file appeared since the check; 0600 since it holds secrets.
  writeFileSync(path, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return { passphrase, generated };
}
