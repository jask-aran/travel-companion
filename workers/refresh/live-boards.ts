import type { DepartureBoard, TripBundle } from "../../packages/trip-schema/src/index.js";
import {
  buildBoards,
  type BoardContext,
  type DepartureReport,
  type DepartureRequest,
} from "../../packages/trip-normaliser/src/departure-boards.js";
import type { CuratedTimetable } from "../../packages/trip-normaliser/src/curated-timetables.js";
import { translateMissing, translationModel } from "../../packages/trip-normaliser/src/translate-api.js";
import {
  boardIsFresh,
  boardQuestion,
  localDate,
  readBoardQuestion,
  type BoardQuestion,
} from "../../apps/web/src/lib/departures-api.js";
import { departureTargets } from "../../apps/web/src/lib/departure-targets.js";
import { FAILURE_REMEMBERED_MS, counting, type Defer, type Guard } from "./guard.js";
import { shared } from "./stored-trip.js";

/**
 * `api/departures?leg=<leg key>&q=<question>`: one leg's board, built from
 * the providers, the curated timetables and translated names, kept in KV and
 * given to everyone who asks until it is old (departures-api.ts says how
 * old). The question names the kept board, so a kept one is served without
 * opening the trip; a build is only for a leg of the stored trip, and asks
 * the trip's own question for it, never the caller's. An app shell from
 * before `leg=` sends the question alone: it gets what is kept, never a
 * build. The caller's token is checked before this runs. A build that asked
 * a provider and failed is remembered in the board's KV record for an hour
 * (FAILURE_REMEMBERED_MS): until then the kept board, or none, is the answer.
 */

/** Every trip's curated timetables, inlined by scripts/bundle-refresh.ts. */
declare const __TIMETABLES__: Record<string, CuratedTimetable[]> | undefined;
const timetablesFor = (tripId: string): CuratedTimetable[] =>
  (typeof __TIMETABLES__ === "object" ? __TIMETABLES__[tripId] : undefined) ?? [];

export type BoardStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

export type LiveBoardEnv = {
  TRIP: BoardStore;
  PUBLIC_ID: string;
  GOOGLE_MAPS_API_KEY?: string;
  /** RapidAPI key for NAVITIME's route search. */
  NAVITIME_API_KEY?: string;
  /** Selects Google's Translation LLM for names. */
  GOOGLE_PROJECT_NUMBER?: string;
};

/** A board's KV record: the board and when it was fetched, and when a build last failed. */
type Stored = { board?: DepartureBoard | null; fetchedAt?: string; failedAt?: string };

const TRANSLATIONS_KEY = "translations";

async function readJson<T>(store: BoardStore, key: string): Promise<T | undefined> {
  const text = await store.get(key);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

async function hashOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Names translated once for every board and every pull, kept in KV by model.
 * Costs a KV read, a Translation request (through the guard) when a name is
 * new, and a KV write then. Never throws: a store that can't be read asks
 * nobody, and one that can't be written loses only the new names.
 */
export async function translateStored(
  texts: string[],
  env: LiveBoardEnv,
  guard: Guard,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<{ translations: Record<string, string>; report?: { failed?: string } }> {
  const model = translationModel(env.GOOGLE_PROJECT_NUMBER);
  let store: Record<string, Record<string, string>>;
  try {
    store = (await readJson<Record<string, Record<string, string>>>(env.TRIP, TRANSLATIONS_KEY)) ?? {};
  } catch (error) {
    return { translations: {}, report: { failed: `translations unreadable: ${String(error)}` } };
  }
  const cache = (store[model ?? "nmt"] ??= {});
  const before = Object.keys(cache).length;
  const result = await translateMissing(texts, env.GOOGLE_MAPS_API_KEY, cache, model, { ...options, fetch: guard.fetch });
  if (Object.keys(cache).length !== before) {
    await env.TRIP.put(TRANSLATIONS_KEY, JSON.stringify(store)).catch((error: unknown) => {
      console.warn(JSON.stringify({ message: "translations not kept", error: String(error) }));
    });
  }
  return result;
}

/**
 * A board asked for now, or undefined if the provider couldn't be asked or
 * failed; `sent` counts the provider requests that went out for it.
 */
async function askProviders(
  question: BoardQuestion,
  env: LiveBoardEnv,
  guard: Guard,
  now: Date,
): Promise<{ board: DepartureBoard | null | undefined; sent: number }> {
  const { from, to } = question;
  const request: DepartureRequest = {
    key: "live",
    fromPlaceId: from.id,
    toPlaceId: to.id,
    provider: question.provider,
    kind: question.kind,
    date: question.date,
    time: question.time,
    ...(question.until ? { until: question.until } : {}),
  };
  // What building a board reads of the trip: the two places, and the leg's
  // estimate for the plausibility check.
  const context = {
    places: { [from.id]: from, [to.id]: to },
    routeLegs: question.estimateSeconds
      ? { live: { id: "live", fromPlaceId: from.id, toPlaceId: to.id, durationSeconds: question.estimateSeconds } }
      : {},
  } as unknown as BoardContext;
  const report: DepartureReport = { requested: { google: 0, navitime: 0 }, skipped: 0, errors: [] };
  const asked = counting(guard.fetch);
  const boards = await buildBoards(
    context,
    [request],
    {
      fetch: asked.fetch,
      keys: { google: env.GOOGLE_MAPS_API_KEY, navitime: env.NAVITIME_API_KEY },
      timetables: timetablesFor(env.PUBLIC_ID),
      translate: (texts) => translateStored(texts, env, guard),
      // The guard counts NAVITIME's month as it sends; this only skips a refused one early.
      mayAskNavitime: () => guard.available("navitime"),
      now,
    },
    report,
  );
  if (report.errors.length) console.error(JSON.stringify({ message: "live board failed", errors: report.errors }));
  // A provider that was needed but couldn't be asked (no key, or the month's
  // NAVITIME spent), or failed: not an answer to keep. A board from a
  // timetable alone asks no one, and is one.
  if (report.errors.length || report.skipped) return { board: undefined, sent: asked.sent() };
  return { board: boards.live ?? null, sent: asked.sent() };
}

/** Where a question's board is kept; the app's and the connector's questions share it. */
export async function boardKey(question: BoardQuestion): Promise<string> {
  return `boards/${await hashOf(JSON.stringify(question))}`;
}

export type KeptBoard = {
  /** undefined: no board kept, only a failure marker. */
  board: DepartureBoard | null | undefined;
  /** Young enough to give out. */
  fresh: boolean;
  /** A build failed within FAILURE_REMEMBERED_MS: don't ask again yet. */
  failing: boolean;
};

/** What KV keeps for a question: the board, whether it is fresh, whether a build just failed. One KV read. */
export async function storedBoard(question: BoardQuestion, env: LiveBoardEnv, now: Date): Promise<KeptBoard | undefined> {
  const stored = await readJson<Stored>(env.TRIP, await boardKey(question));
  if (!stored) return undefined;
  const board = stored.board === undefined || !stored.fetchedAt ? undefined : stored.board;
  return {
    board,
    fresh: board !== undefined && boardIsFresh(question, new Date(stored.fetchedAt!), now),
    failing: now.getTime() - Date.parse(stored.failedAt ?? "") < FAILURE_REMEMBERED_MS,
  };
}

/** Adds a failure time to the board's record, keeping any old board. A KV read and write. */
async function markFailed(env: LiveBoardEnv, key: string, now: Date): Promise<void> {
  try {
    const previous = (await readJson<Stored>(env.TRIP, key)) ?? {};
    await env.TRIP.put(key, JSON.stringify({ ...previous, failedAt: now.toISOString() } satisfies Stored));
  } catch (error) {
    console.error(JSON.stringify({ message: "board failure not kept", error: String(error) }));
  }
}

/**
 * A board built now and kept, or undefined if a provider couldn't be asked
 * or failed (no board is kept then; a failure after asking is marked). One
 * build per question at a time in this isolate; a failed KV write still
 * returns the board. Costs, counted from buildBoards: Google asks Routes 3
 * times (7 for an airport window), NAVITIME once, each request with the
 * guard's KV read and write of its count; then one KV read of the
 * translations, one Translation request with its count read and write and
 * one KV write when a name is new; then one KV write of the board, or a KV
 * read and write of the failure marker. The guard's own reads are per
 * invocation (guard.ts).
 */
export async function buildBoard(
  question: BoardQuestion,
  env: LiveBoardEnv,
  guard: Guard,
  now: Date,
): Promise<DepartureBoard | null | undefined> {
  const key = await boardKey(question);
  return shared(key, async () => {
    const { board, sent } = await askProviders(question, env, guard, now);
    if (board === undefined) {
      if (sent) await markFailed(env, key, now);
      return undefined;
    }
    try {
      await env.TRIP.put(key, JSON.stringify({ board, fetchedAt: now.toISOString() } satisfies Stored));
    } catch (error) {
      console.error(JSON.stringify({ message: "board not kept", error: String(error) }));
    }
    return board;
  }, undefined);
}

export async function liveBoard(
  params: URLSearchParams,
  env: LiveBoardEnv,
  guard: Guard,
  trip: () => Promise<TripBundle | undefined>,
  now = new Date(),
  defer?: Defer,
): Promise<Response> {
  const asked = readBoardQuestion(params.get("q"));
  const leg = params.get("leg");
  if (!asked) return new Response(null, { status: 400 });
  const reply = (board: DepartureBoard | null, state: "stored" | "fetched" | "stale" | "none") =>
    Response.json({ board }, { headers: { "cache-control": "no-cache", "x-board": state } });
  // An old board beats none when the providers can't be asked.
  const kept = (stored: KeptBoard | undefined) =>
    reply(stored?.board ?? null, stored?.board !== undefined ? "stale" : "none");

  const stored = await storedBoard(asked, env, now);
  if (stored?.fresh) return reply(stored.board ?? null, "stored");
  // An app shell from before `leg=`: what is kept, never a build.
  if (leg === null || stored?.failing) return kept(stored);
  if (!(await guard.available(asked.provider))) return kept(stored);

  const bundle = await trip();
  const target = bundle && departureTargets(bundle).find((candidate) => candidate.key === leg);
  const question = target && boardQuestion(target, bundle);
  if (!question) return kept(stored);
  let current = stored;
  if (JSON.stringify(question) !== JSON.stringify(asked)) {
    // The caller's trip differs from the stored one: the stored one's question is the one built.
    current = (await storedBoard(question, env, now)) ?? stored;
    if (current?.fresh) return reply(current.board ?? null, "stored");
  }
  // A past day's board is history: what is kept is all it gets.
  if (question.date < localDate(question.from, now) || current?.failing) return kept(current);
  const building = buildBoard(question, env, guard, now);
  defer?.(building);
  const board = await building;
  if (board === undefined) return kept(current);
  return reply(board, "fetched");
}
