import { parseTripBundle, type TripBundle } from "../../packages/trip-schema/src/index.js";
import { decryptTrip, type EncryptedPayload } from "../../apps/web/src/lib/trip-crypto.js";
import { dayBrief, tripBookings, tripBrief, tripDates, tripOverview } from "../../packages/trip-brief/src/index.js";

/**
 * Read-only MCP server for the travellers' chat agents. Streamable HTTP,
 * stateless, JSON only. Dual-era (spec 2026-07-28): a request carrying
 * `_meta["io.modelcontextprotocol/protocolVersion"]` is served the modern way;
 * anything else is a legacy client that opens with `initialize`.
 */

const SERVER_NAME = "trip-companion";
const SERVER_VERSION = "1.0.0";

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
/** Before 2025-06-18 there was no MCP-Protocol-Version header (spec: assume 2025-03-26). */
const HEADERLESS_VERSION = "2025-03-26";

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const MAX_BODY_BYTES = 64_000;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_VERSION = -32022;

const INSTRUCTIONS =
  "The travellers' own itinerary for this trip, kept in their trip app: every day's stops in order with times, " +
  "opening hours, where they stay each night, flights, booking and confirmation references, cancellation terms, notes, " +
  "and how to get between stops, with departure times where they are known. Start with get_overview (small: one line per day). " +
  "Use get_bookings for booking references, flights, hotels, guests and cancellation deadlines. " +
  "Use get_day for what happens on a date or a run of dates: its text already includes place details, opening hours, " +
  "notes and the transit options between stops (with departure times where known), so there is no separate tool for those. " +
  "Use get_trip only when a question truly spans the whole trip; it is large. Read-only: it cannot change the plan.";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const DATE = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } as const;
const NO_ARGUMENTS = { type: "object", properties: {}, additionalProperties: false };

const TOOLS = [
  {
    name: "get_overview",
    title: "Trip overview",
    description:
      "Call this first. A short overview of the whole trip: dates, time zones, and one line per day with the town, " +
      "where they sleep, how many stops, and any flight. Use it to find which date a question is about, then get_day " +
      "for that date's detail or get_bookings for references.",
    inputSchema: NO_ARGUMENTS,
    annotations: { title: "Trip overview", ...READ_ONLY },
  },
  {
    name: "get_bookings",
    title: "Bookings",
    description:
      "Every flight and every stay once, in date order, with all booking data: flight numbers, airports, times, " +
      "booking references, travellers; hotel name, address, phone, website, check-in and check-out, nights, guests, " +
      "cancellation deadline and policy, and the subject line of the booking email (to search the traveller's mail). " +
      "Use it for questions about references, flights, hotels or cancelling.",
    inputSchema: NO_ARGUMENTS,
    annotations: { title: "Bookings", ...READ_ONLY },
  },
  {
    name: "get_day",
    title: "Day detail",
    description:
      "Full detail of one date, or of every date from `date` to `through`: stops in order with times, opening hours " +
      "that day, place details and notes, the stay that night, flights and when to be at the airport, and how to get " +
      "between stops (mode, duration, lines, and departure options with times where known, the suggested one marked). Transit " +
      "options and place details are already in this text; there is no separate tool for them. An unknown date " +
      "returns the list of trip dates.",
    inputSchema: {
      type: "object",
      properties: {
        date: { ...DATE, description: "The day, as YYYY-MM-DD in the trip's local calendar." },
        through: { ...DATE, description: "Optional last day of a run, YYYY-MM-DD, on or after `date`." },
      },
      required: ["date"],
      additionalProperties: false,
    },
    annotations: { title: "Day detail", ...READ_ONLY },
  },
  {
    name: "get_trip",
    title: "Whole trip itinerary",
    description:
      "The whole itinerary as one large text (every day in full). Use it only when a question truly spans the whole " +
      "trip and get_overview, get_bookings or a get_day run cannot answer it.",
    inputSchema: NO_ARGUMENTS,
    annotations: { title: "Whole trip itinerary", ...READ_ONLY },
  },
];

export type TripBriefs = {
  tripBrief(bundle: TripBundle): string;
  tripOverview(bundle: TripBundle): string;
  tripBookings(bundle: TripBundle): string;
  dayBrief(bundle: TripBundle, date: string, through?: string): string | undefined;
  tripDates(bundle: TripBundle): string[];
};

export type McpDeps = {
  /** The decrypted trip; only called by `tools/call`. */
  loadBundle(): Promise<TripBundle>;
  /** Tests inject this; the worker uses `packages/trip-brief`. */
  briefs?: TripBriefs;
  /**
   * Departure boards for the legs of these dates, in a copy of the trip
   * (connector-boards.ts); `build` lets missing ones be fetched now. `note`
   * is a sentence for the end of the text. Without it the trip's own boards
   * are all there is.
   */
  withBoards?(bundle: TripBundle, scope: { dates: string[]; build: boolean }): Promise<{ bundle: TripBundle; note?: string }>;
};

const defaultBriefs: TripBriefs = { tripBrief, tripOverview, tripBookings, dayBrief, tripDates };

let opened: { ciphertext: string; passphrase: string; bundle: Promise<TripBundle> } | undefined;

/**
 * Decrypt and parse a `trip.enc` payload. PBKDF2 at 100,000 iterations is
 * the slow part, so the last result is kept for the life of the isolate,
 * keyed by the ciphertext: a new upload is a new string and opens afresh.
 * Callers must not mutate the bundle it returns.
 */
export function openTrip(ciphertext: string, passphrase: string): Promise<TripBundle> {
  if (opened && opened.ciphertext === ciphertext && opened.passphrase === passphrase) return opened.bundle;
  const bundle = (async () => {
    const payload = JSON.parse(ciphertext) as EncryptedPayload;
    return parseTripBundle(JSON.parse(await decryptTrip(payload, passphrase)));
  })();
  const entry = { ciphertext, passphrase, bundle };
  opened = entry;
  bundle.catch(() => {
    if (opened === entry) opened = undefined;
  });
  return bundle;
}

// Rate limits: Pages rejects the `ratelimits` binding and KV writes per request
// would spend the free allowance, so this is a best-effort window per isolate.

export const AGENT_LIMIT = { requests: 60, windowMs: 60_000 };
export const WRONG_TOKEN_LIMIT = { requests: 10, windowMs: 60_000 };

type Window = { start: number; count: number };
const windows = new Map<string, Window>();
const MAX_KEYS = 10_000;

/** True while `key` is still under `limit`; counts this request. */
export function takeToken(key: string, limit: { requests: number; windowMs: number }, now = Date.now()): boolean {
  let window = windows.get(key);
  if (!window || now - window.start >= limit.windowMs) {
    if (windows.size >= MAX_KEYS) {
      for (const [stale, entry] of windows) if (now - entry.start >= limit.windowMs) windows.delete(stale);
      if (windows.size >= MAX_KEYS) windows.clear();
    }
    window = { start: now, count: 0 };
    windows.set(key, window);
  }
  window.count += 1;
  return window.count <= limit.requests;
}

export function retryAfterSeconds(key: string, limit: { windowMs: number }, now = Date.now()): number {
  const window = windows.get(key);
  return Math.max(1, Math.ceil(((window?.start ?? now) + limit.windowMs - now) / 1000));
}

/** Tests only. */
export function resetMcpState(): void {
  windows.clear();
  opened = undefined;
}


type Id = string | number | null;
type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
type Reply = { status: number; body?: unknown };

const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function rpcError(id: Id, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function rpcResult(id: Id, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `Mcp-Name` may be `=?base64?…?=` (spec: Value Encoding). */
function decodeHeader(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!match) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match[1] ?? ""), (char) => char.charCodeAt(0)));
  } catch {
    return "\u0000invalid";
  }
}

function textResult(text: string, isError = false) {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

async function callTool(params: Record<string, unknown>, deps: McpDeps): Promise<unknown> {
  const briefs = deps.briefs ?? defaultBriefs;
  const args = isRecord(params.arguments) ? params.arguments : {};
  /** Never fails the call: without its boards the trip still answers. */
  const withBoards = async (bundle: TripBundle, dates: string[], build: boolean) => {
    if (!deps.withBoards) return { bundle };
    try {
      return await deps.withBoards(bundle, { dates, build });
    } catch (error) {
      console.warn(JSON.stringify({ message: "boards left out", error: String(error) }));
      return { bundle };
    }
  };
  if (params.name === "get_trip") {
    // Kept boards only: building one is get_day's job, a day at a time.
    const bundle = await deps.loadBundle();
    return textResult(briefs.tripBrief((await withBoards(bundle, briefs.tripDates(bundle), false)).bundle));
  }
  if (params.name === "get_overview") return textResult(briefs.tripOverview(await deps.loadBundle()));
  if (params.name === "get_bookings") return textResult(briefs.tripBookings(await deps.loadBundle()));
  // get_day; callers have already rejected any other name.
  const bundle = await deps.loadBundle();
  const dates = briefs.tripDates(bundle);
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = typeof args.date === "string" ? args.date : "";
  const through = typeof args.through === "string" ? args.through : undefined;
  const valid = `Valid dates: ${dates.join(", ")}.`;
  if (!isDate(date) || !dates.includes(date)) {
    const asked = date ? `No day ${date} in this trip.` : "`date` is required, as YYYY-MM-DD.";
    return textResult(`${asked} ${valid}`, true);
  }
  if ("through" in args && (through === undefined || !isDate(through) || !dates.includes(through) || through < date)) {
    const why = through && dates.includes(through) ? `\`through\` (${through}) is before \`date\` (${date}).` : `No day ${String(args.through)} in this trip for \`through\`.`;
    return textResult(`${why} ${valid}`, true);
  }
  const range = dates.filter((day) => day >= date && day <= (through ?? date));
  const boarded = await withBoards(bundle, range, true);
  const brief = briefs.dayBrief(boarded.bundle, date, through);
  if (brief === undefined) return textResult(`No day ${date} in this trip. ${valid}`, true);
  return textResult(boarded.note ? `${brief.trimEnd()}\n\n${boarded.note}\n` : brief);
}

/** One JSON-RPC message; undefined for a notification or a client response (202). */
async function answer(message: unknown, request: Request, deps: McpDeps): Promise<Reply | undefined> {
  if (!isRecord(message) || message.jsonrpc !== "2.0") {
    return { status: 400, body: rpcError(null, INVALID_REQUEST, "Invalid request") };
  }
  const { method } = message as Message;
  const hasId = "id" in message && (typeof message.id === "string" || typeof message.id === "number");
  if (typeof method !== "string") {
    // A client's response to us (we never ask), or junk.
    if (hasId && ("result" in message || "error" in message)) return undefined;
    return { status: 400, body: rpcError(null, INVALID_REQUEST, "Invalid request") };
  }
  if (!hasId) {
    if ("id" in message && message.id !== undefined) {
      return { status: 400, body: rpcError(null, INVALID_REQUEST, "Invalid request id") };
    }
    // notifications/initialized, notifications/cancelled, …: nothing to do.
    return undefined;
  }
  const id = message.id as string | number;
  const params = isRecord(message.params) ? message.params : {};
  const meta = isRecord(params._meta) ? params._meta : {};
  const headerVersion = request.headers.get("mcp-protocol-version");

  const modernVersion = typeof meta[META_VERSION] === "string" ? (meta[META_VERSION] as string) : undefined;
  const modern = modernVersion !== undefined && method !== "initialize";
  const complete = (result: Record<string, unknown>) => (modern ? { resultType: "complete", ...result } : result);

  if (modern) {
    if (headerVersion !== modernVersion) {
      return { status: 400, body: rpcError(id, HEADER_MISMATCH, `Header mismatch: MCP-Protocol-Version '${headerVersion ?? ""}' does not match body '${modernVersion}'`) };
    }
    if (!MODERN_VERSIONS.includes(modernVersion)) {
      return { status: 400, body: rpcError(id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested: modernVersion }) };
    }
    const methodHeader = request.headers.get("mcp-method");
    if (methodHeader !== method) {
      return { status: 400, body: rpcError(id, HEADER_MISMATCH, `Header mismatch: Mcp-Method '${methodHeader ?? ""}' does not match body '${method}'`) };
    }
    if (method === "tools/call") {
      const nameHeader = request.headers.get("mcp-name");
      if (nameHeader === null || decodeHeader(nameHeader) !== params.name) {
        return { status: 400, body: rpcError(id, HEADER_MISMATCH, "Header mismatch: Mcp-Name does not match params.name") };
      }
    }
  } else if (method !== "initialize") {
    const version = headerVersion ?? HEADERLESS_VERSION;
    if (!LEGACY_VERSIONS.includes(version)) {
      return { status: 400, body: rpcError(id, INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${version}`, { supported: SUPPORTED_VERSIONS }) };
    }
  }

  const ok = (result: Record<string, unknown>): Reply => ({ status: 200, body: rpcResult(id, complete(result)) });
  const serverInfo = { name: SERVER_NAME, title: "Trip companion", version: SERVER_VERSION };
  const capabilities = { tools: { listChanged: false } };

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      return ok({ protocolVersion, capabilities, serverInfo, instructions: INSTRUCTIONS });
    }
    case "server/discover":
      return ok({
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities,
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some((tool) => tool.name === params.name)) {
        return { status: 200, body: rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`) };
      }
      return ok((await callTool(params, deps)) as Record<string, unknown>);
    }
    default:
      // Modern clients tell a missing method from a missing endpoint by the 404 + JSON-RPC body.
      return { status: modern ? 404 : 200, body: rpcError(id, METHOD_NOT_FOUND, `Method not found: ${method}`) };
  }
}

/** The MCP endpoint. Token and rate limits are checked by the caller. */
export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  if (request.method !== "POST") {
    // No server-initiated stream (GET) and no sessions to end (DELETE).
    return new Response(null, { status: 405, headers: { ...NO_STORE, allow: "POST" } });
  }
  // No Origin allow-list: the secret in the URL is the whole credential, and a
  // list of known hosts would lock out any agent harness not on it.
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json(rpcError(null, INVALID_REQUEST, "Request too large"), 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(rpcError(null, PARSE_ERROR, "Parse error"), 400);
  }

  // Batches existed only in 2025-03-26; answering one costs nothing.
  if (Array.isArray(body)) {
    if (body.length === 0) return json(rpcError(null, INVALID_REQUEST, "Empty batch"), 400);
    const replies: unknown[] = [];
    for (const message of body) {
      const reply = await answer(message, request, deps);
      if (reply) replies.push(reply.body);
    }
    return replies.length ? json(replies) : new Response(null, { status: 202, headers: NO_STORE });
  }
  const reply = await answer(body, request, deps);
  if (!reply) return new Response(null, { status: 202, headers: NO_STORE });
  return json(reply.body, reply.status);
}

/** For the worker's last-resort catch: never the HTML shell on this route. */
export function mcpFailure(): Response {
  return json(rpcError(null, INTERNAL_ERROR, "Internal error"), 500);
}
