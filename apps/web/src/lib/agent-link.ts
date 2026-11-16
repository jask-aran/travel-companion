/**
 * The agent link: one URL a traveller pastes into their chat agent (Claude,
 * ChatGPT) as an MCP server, so it can read the trip. The link itself is the
 * secret, `<base>mcp/<token>`: there is no OAuth and no header, since anyone
 * who can open the trip page is already trusted with all of it. Shared by
 * the app (the footer button) and the Pages worker (`workers/refresh/mcp.ts`)
 * so both agree on the path and the token.
 */

export const AGENT_ROUTE = "mcp";

/**
 * A hash of the passphrase, like `mediaToken`, but salted differently and
 * full length: a media token sits in photo URLs anyone can copy and opens
 * only images, while this one opens the whole trip. The two must never be
 * equal.
 */
export async function agentToken(passphrase: string): Promise<string> {
  const bytes = new TextEncoder().encode(`travel-companion/agent/${passphrase}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `base` is the app's base URL, e.g. `https://trips.example/my-trip/`. */
export function agentLink(base: string, token: string): string {
  return `${base.replace(/\/+$/, "")}/${AGENT_ROUTE}/${token}`;
}
