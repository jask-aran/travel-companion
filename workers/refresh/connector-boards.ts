import type { DepartureBoard, TripBundle } from "../../packages/trip-schema/src/index.js";
import { departureTargets } from "../../apps/web/src/lib/departure-targets.js";
import { boardAnswers, boardQuestion, localDate, type BoardQuestion } from "../../apps/web/src/lib/departures-api.js";
import type { Defer, Guard } from "./guard.js";
import { buildBoard, storedBoard, type LiveBoardEnv } from "./live-boards.js";

/**
 * Departure boards for the connector, so an agent gets departure times on a
 * deployment nobody pulls from a laptop. For each leg in scope: the trip's
 * own board, else the board `api/departures` kept for the same question,
 * else (get_day only) one built now through the same code and kept the same
 * way. The trip is never changed: the boards go into a copy for the renderer.
 * Nothing is built while the provider's breaker is open or its budget is
 * spent, nor for a leg whose build failed within the hour, nor after a build
 * fails in the same invocation.
 *
 * The caps (subrequests, boards built, "stopped") belong to the invocation
 * (`BoardSession`), not to one JSON-RPC message, so a batch of get_day
 * messages shares them.
 *
 * Cloudflare's free plan allows 50 subrequests an invocation, every fetch
 * and KV read or write counted. Before boards, at most 20, on the worst
 * path (no trip in KV, no shipped file, checked within the hour but not
 * within REFRESH_GAP_MS): the idle check's KV read of the check time (1);
 * the trip from KV and the static file (2); the pull: a KV write of the
 * check time, Wanderlog, the previous trip from KV and the static file, the
 * translations' KV read, Google's breaker and count reads, a Translation
 * request with its count read and write, the translations' KV write and the
 * trip's KV write (12); the trip read again from KV (1); NAVITIME's breaker
 * and count reads (2); a breaker write per provider (2). (When the idle
 * check pulls instead, 19.) Board work gets the other 30.
 */
export const BOARD_SUBREQUESTS = 30;
/** One kept-board lookup: a KV read. */
const LOOKUP_COST = 1;
/**
 * Names (a KV read, a Translation request with its count read and write, a
 * KV write) and the board's KV write, or the failure marker's read and write.
 */
const AFTER_BUILD_COST = 7;
/** One provider request: the request, and the guard's count read and write. */
const REQUEST_COST = 3;

/**
 * One board built, at its worst (buildBoard): Google asks Routes 7 times for
 * an airport window, 3 otherwise and none for a timetable-only day board;
 * NAVITIME asks once.
 */
export function buildCost(question: Pick<BoardQuestion, "provider" | "kind" | "until">): number {
  if (question.provider === "navitime") return REQUEST_COST + AFTER_BUILD_COST;
  const requests = question.until ? 7 : question.kind === "day" ? 0 : 3;
  return requests * REQUEST_COST + AFTER_BUILD_COST;
}

/**
 * Boards one invocation may build. With lookups, 30 fits two NAVITIME
 * boards (2 × (1 + 10)), one Google board (1 + 16) with a NAVITIME one, or
 * one airport window (1 + 28).
 */
export const MAX_BOARDS_BUILT = 2;

export const MORE_BOARDS_NEXT_CALL = "More departure times are being fetched and will be there on the next call.";

export type BoardScope = {
  /** The trip dates whose legs want boards. */
  dates: readonly string[];
  /** Build missing boards (get_day); otherwise only kept ones are read (get_trip). */
  build: boolean;
};

/** One invocation's board caps, shared by every message of a batch. */
export type BoardSession = {
  /** Subrequests left for board work. */
  budget: number;
  /** Boards built so far. */
  built: number;
  /** A provider couldn't be asked or failed: the next build would fare no better. */
  stopped: boolean;
};

export const boardSession = (): BoardSession => ({ budget: BOARD_SUBREQUESTS, built: 0, stopped: false });

export async function connectorBoards(
  bundle: TripBundle,
  scope: BoardScope,
  env: LiveBoardEnv,
  guard: Guard,
  options: { now?: Date; session?: BoardSession; defer?: Defer } = {},
): Promise<{ bundle: TripBundle; note?: string }> {
  const now = options.now ?? new Date();
  const session = options.session ?? boardSession();
  const dates = new Set(scope.dates);
  const filled: Record<string, DepartureBoard> = {};
  /** Legs left for a later call by the caps. */
  let waiting = 0;

  for (const target of departureTargets(bundle)) {
    if (!dates.has(target.date) || boardAnswers(bundle.departures?.[target.key], target)) continue;
    const question = boardQuestion(target, bundle);
    if (!question) continue;
    if (session.budget < LOOKUP_COST) {
      waiting += 1;
      continue;
    }
    session.budget -= LOOKUP_COST;
    const stored = await storedBoard(question, env, now).catch(() => undefined);
    if (stored?.board) filled[target.key] = stored.board;
    // A past day's board is history: what is kept is all it gets, as in the app.
    if (stored?.fresh || stored?.failing || !scope.build || session.stopped || target.date < localDate(question.from, now)) continue;
    if (!(await guard.available(question.provider))) {
      session.stopped = true;
      continue;
    }
    const cost = buildCost(question);
    if (session.built >= MAX_BOARDS_BUILT || session.budget < cost) {
      if (!stored?.board) waiting += 1;
      continue;
    }
    session.built += 1;
    session.budget -= cost;
    try {
      // undefined: a provider couldn't be asked or failed; an old board stands.
      const building = buildBoard(question, env, guard, now);
      options.defer?.(building);
      const board = await building;
      if (board) filled[target.key] = board;
      if (board === undefined) session.stopped = true;
    } catch (error) {
      session.stopped = true;
      console.warn(JSON.stringify({ message: "connector board failed", error: String(error) }));
    }
  }

  const copy = Object.keys(filled).length ? { ...bundle, departures: { ...bundle.departures, ...filled } } : bundle;
  return waiting && scope.build && !session.stopped ? { bundle: copy, note: MORE_BOARDS_NEXT_CALL } : { bundle: copy };
}
