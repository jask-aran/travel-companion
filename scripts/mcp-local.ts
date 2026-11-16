import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseTripBundle } from "../packages/trip-schema/src/index.js";
import { loadIngestionConfigSync } from "../packages/wanderlog-import/src/config.js";
import { handleMcp } from "../workers/refresh/mcp.js";

/**
 * The Pages function's MCP server, reading the local working bundle.
 * Bound to 127.0.0.1 with no token; the Host check stops DNS rebinding from a web page.
 */

export function startLocalMcp(options: { port: number; bundlePath: string }): Promise<Server> {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const bound = (server.address() as AddressInfo).port;
      const allowedHosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
      const path = (incoming.url ?? "").split("?")[0];
      if (path !== "/mcp" || !allowedHosts.has(incoming.headers.host ?? "")) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (typeof value === "string") headers.set(name, value);
      }
      const request = new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method ?? "GET",
        headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await handleMcp(request, {
        // Read on every call, so a later `pnpm trip:pull` shows without a restart.
        loadBundle: async () => parseTripBundle(JSON.parse(await readFile(options.bundlePath, "utf8"))),
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      console.error(`mcp: ${error instanceof Error ? error.message : String(error)}`);
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end();
    });
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(options.port, "127.0.0.1", () => done(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "4190" },
      bundle: { type: "string" },
      config: { type: "string", default: "config/trip.local.yaml" },
    },
  });
  const port = Number(values.port);
  let bundlePath = values.bundle;
  if (!bundlePath) {
    const loaded = loadIngestionConfigSync(values.config!);
    bundlePath = loaded.resolvePath(loaded.config.paths.workingBundle);
  }
  await startLocalMcp({ port, bundlePath: resolve(bundlePath) });
  console.log(`Trip connector running. Paste this as the MCP server URL:\n\n  http://127.0.0.1:${port}/mcp\n`);
  console.log("It works for agents on this computer (Claude Code, desktop apps), not for claude.ai or ChatGPT on the web, which cannot reach this address; those need the deployed site's connector link.");
  console.log(`Serving ${bundlePath}. Ctrl+C to stop.`);
}
