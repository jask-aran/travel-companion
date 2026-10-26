import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { DepartureBoard, TripBundle } from "@travel-companion/trip-schema";
import { departureTargets, type DepartureTarget } from "./departure-targets.js";
import { DEPARTURES_ROUTE, boardQuestion, isSoon, localDate, type BoardQuestion } from "./departures-api.js";
import { mediaUrl } from "./place-photo.js";

/**
 * The boards a pull put in the trip, with live ones over them: today's and
 * tomorrow's legs, and any leg the pull has no board for (a stop added or
 * moved on the phone since). The worker keeps each answer for everyone, so
 * this costs a provider request only when its copy is old. Offline, or if
 * the worker can't answer, the pulled boards stand.
 */

/** Asking again on return to the app sooner than this would only reread the worker's copy. */
const RECHECK_MS = 30 * 60_000;

const sameTarget = (board: DepartureBoard | undefined, target: DepartureTarget) =>
  Boolean(board) &&
  board!.target.kind === target.kind &&
  board!.target.date === target.date &&
  board!.target.time === target.time &&
  board!.target.until === target.until;

/** The legs to ask the worker about, with their questions. Past days are left as they are. */
export function liveQuestions(bundle: TripBundle, now: Date): { key: string; question: BoardQuestion }[] {
  return departureTargets(bundle).flatMap((target) => {
    const question = boardQuestion(target, bundle);
    if (!question || target.date < localDate(question.from, now)) return [];
    const pulled = bundle.departures?.[target.key];
    return isSoon(question, now) || !sameTarget(pulled, target) ? [{ key: target.key, question }] : [];
  });
}

/** The worker's board, null if it found none, undefined if it couldn't be asked. */
async function fetchBoard(question: BoardQuestion): Promise<DepartureBoard | null | undefined> {
  try {
    const response = await fetch(mediaUrl(DEPARTURES_ROUTE, { q: JSON.stringify(question) }));
    if (!response.ok) return undefined;
    const { board } = (await response.json()) as { board?: DepartureBoard | null };
    return board ?? null;
  } catch {
    return undefined;
  }
}

/** The trip as loaded, with live boards over the pulled ones once they arrive. */
export function withLiveBoards(trip: Accessor<TripBundle | undefined>): Accessor<TripBundle | undefined> {
  const [live, setLive] = createSignal<Record<string, DepartureBoard>>({});
  let checkedAt = 0;

  const check = async (bundle: TripBundle) => {
    checkedAt = Date.now();
    const asked = liveQuestions(bundle, new Date());
    if (!asked.length) return;
    const boards = await Promise.all(asked.map(({ question }) => fetchBoard(question)));
    // Offline, a board fetched earlier this session beats the pulled one.
    const fresh = Object.fromEntries(
      asked.flatMap(({ key }, index) => {
        const board = boards[index] === undefined ? live()[key] : boards[index];
        return board ? [[key, board]] : [];
      }),
    );
    // One update, and none if nothing changed, so open boards don't redraw for nothing.
    if (JSON.stringify(fresh) !== JSON.stringify(live())) setLive(fresh);
  };

  createEffect(() => {
    const bundle = trip();
    if (bundle) void check(bundle);
  });

  // A phone left open overnight: tomorrow's leg is today's, and a new
  // tomorrow wants a board.
  const onVisible = () => {
    const bundle = trip();
    if (bundle && document.visibilityState === "visible" && Date.now() - checkedAt > RECHECK_MS) void check(bundle);
  };
  document.addEventListener("visibilitychange", onVisible);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisible));

  return createMemo(() => {
    const bundle = trip();
    const boards = live();
    if (!bundle || !Object.keys(boards).length) return bundle;
    return { ...bundle, departures: { ...bundle.departures, ...boards } };
  });
}
