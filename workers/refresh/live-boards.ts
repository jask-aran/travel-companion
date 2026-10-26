import type { DepartureBoard } from "../../packages/trip-schema/src/index.js";
import {
  buildBoards,
  type BoardContext,
  type DepartureReport,
  type DepartureRequest,
} from "../../packages/trip-normaliser/src/departure-boards.js";
import type { CuratedTimetable } from "../../packages/trip-normaliser/src/curated-timetables.js";
import { translateMissing, translationModel } from "../../packages/trip-normaliser/src/translate-api.js";
import { boardLifetimeMs, readBoardQuestion, type BoardQuestion } from "../../apps/web/src/lib/departures-api.js";

/**
 * `api/departures`: one leg's board, built as a pull builds it (the same
 * providers, curated timetables and names), kept in KV and given to
 * everyone who asks until it is old (departures-api.ts says how old). The
 * caller's token is checked before this runs.
 */

/** Every trip's curated timetables, inlined by scripts/bundle-refresh.ts. */
declare const __TIMETABLES__: Record<string, CuratedTimetable[]> | undefined;
const timetablesFor = (tripId: string): CuratedTimetable[] =>
  (typeof __TIMETABLES__ === "object" ? __TIMETABLES__[tripId] : undefined) ?? [];

/**
 * NAVITIME's plan allows 500 requests a month and counts failed ones; this
 * leaves the rest for pulls from the laptop. Its months run from the
 * subscription date, so a calendar month is an approximation.
 */
export const LIVE_NAVITIME_MONTHLY = 300;

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
  /** Selects Google's Translation LLM, as the pull's translateProject does. */
  GOOGLE_PROJECT_NUMBER?: string;
};

type Stored = { board: DepartureBoard | null; fetchedAt: string };

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

/** Names translated once for every board, in the pull's cache format. */
async function translateStored(texts: string[], env: LiveBoardEnv) {
  const model = translationModel(env.GOOGLE_PROJECT_NUMBER);
  const store = (await readJson<Record<string, Record<string, string>>>(env.TRIP, TRANSLATIONS_KEY)) ?? {};
  const cache = (store[model ?? "nmt"] ??= {});
  const before = Object.keys(cache).length;
  const result = await translateMissing(texts, env.GOOGLE_MAPS_API_KEY, cache, model);
  if (Object.keys(cache).length !== before) await env.TRIP.put(TRANSLATIONS_KEY, JSON.stringify(store));
  return result;
}

async function spendNavitime(env: LiveBoardEnv, now: Date): Promise<boolean> {
  const key = `navitime/${now.toISOString().slice(0, 7)}`;
  const used = Number(await env.TRIP.get(key)) || 0;
  if (used >= LIVE_NAVITIME_MONTHLY) return false;
  await env.TRIP.put(key, String(used + 1));
  return true;
}

/** A board asked for now, or undefined if the provider couldn't be asked or failed. */
async function askProviders(question: BoardQuestion, env: LiveBoardEnv, now: Date): Promise<DepartureBoard | null | undefined> {
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
  const report: DepartureReport = { boards: 0, cached: 0, requested: { google: 0, navitime: 0 }, skipped: 0, errors: [] };
  const boards = await buildBoards(
    context,
    [request],
    {
      keys: { google: env.GOOGLE_MAPS_API_KEY, navitime: env.NAVITIME_API_KEY },
      cache: {},
      timetables: timetablesFor(env.PUBLIC_ID),
      translate: (texts) => translateStored(texts, env),
      mayAskNavitime: () => spendNavitime(env, now),
      now,
    },
    report,
  );
  if (report.errors.length) console.error(JSON.stringify({ message: "live board failed", errors: report.errors }));
  // A provider that was needed but couldn't be asked (no key, or the month's
  // NAVITIME spent), or failed: not an answer to keep. A board from a
  // timetable alone asks no one, and is one.
  if (report.errors.length || report.skipped) return undefined;
  return boards.live ?? null;
}

export async function liveBoard(raw: string | null, env: LiveBoardEnv, now = new Date()): Promise<Response> {
  const question = readBoardQuestion(raw);
  if (!question) return new Response(null, { status: 400 });
  const key = `boards/${await hashOf(JSON.stringify(question))}`;
  const stored = await readJson<Stored>(env.TRIP, key);
  const reply = (board: DepartureBoard | null, state: "stored" | "fetched" | "stale" | "none") =>
    Response.json({ board }, { headers: { "cache-control": "no-cache", "x-board": state } });

  if (stored && now.getTime() - Date.parse(stored.fetchedAt) < boardLifetimeMs(question, now)) {
    return reply(stored.board, "stored");
  }
  const board = await askProviders(question, env, now);
  // An old board beats none when the providers can't be asked.
  if (board === undefined) return reply(stored?.board ?? null, stored ? "stale" : "none");
  await env.TRIP.put(key, JSON.stringify({ board, fetchedAt: now.toISOString() } satisfies Stored));
  return reply(board, "fetched");
}
