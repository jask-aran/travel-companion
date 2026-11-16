import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { DepartureBoard, TripBundle } from "@travel-companion/trip-schema";
import { departureTargets } from "./departure-targets.js";
import { DEPARTURES_ROUTE, boardAnswers, boardQuestion, isSoon, localDate, type BoardQuestion } from "./departures-api.js";
import { mediaUrl } from "./place-photo.js";
import { hasPagesFunction } from "./pages-function.js";

/**
 * The boards a pull put in the trip, with live ones over them: today's and
 * tomorrow's legs as soon as the trip opens, and, for a day someone opens,
 * any leg the trip has no board for (a stop added or moved on the phone
 * since, or a trip no laptop ever pulled boards for). Opening is the cue so
 * a trip with no boards doesn't ask about every leg at once. The worker
 * keeps each answer for everyone, so this costs a provider request only when its copy is old. Offline, or if
 * the worker can't answer, the pulled boards stand. A static build has no
 * worker to ask, so it shows the pulled boards only.
 */

/** Asking again on return to the app sooner than this would only reread the worker's copy. */
const RECHECK_MS = 30 * 60_000;

/** Dates whose day someone has opened this session (DaySection). */
const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());

/** A day's route is on screen: its legs may want boards. */
export function dayOpened(date: string): void {
  if (!opened().has(date)) setOpened(new Set([...opened(), date]));
}

/**
 * The legs to ask the worker about, with their questions: today's and
 * tomorrow's, and an opened day's legs with no board for them as they now
 * stand. Past days are left as they are.
 */
export function liveQuestions(
  bundle: TripBundle,
  now: Date,
  openedDates: ReadonlySet<string> = new Set(),
): { key: string; question: BoardQuestion }[] {
  return departureTargets(bundle).flatMap((target) => {
    const question = boardQuestion(target, bundle);
    if (!question || target.date < localDate(question.from, now)) return [];
    const missing = !boardAnswers(bundle.departures?.[target.key], target) && openedDates.has(target.date);
    return isSoon(question, now) || missing ? [{ key: target.key, question }] : [];
  });
}

/**
 * The worker's board, null if it found none, undefined if it couldn't be
 * asked. By the leg: the worker builds only the stored trip's legs, from its
 * own question; this one names the board it keeps.
 */
async function fetchBoard(key: string, question: BoardQuestion): Promise<DepartureBoard | null | undefined> {
  try {
    const response = await fetch(mediaUrl(DEPARTURES_ROUTE, { leg: key, q: JSON.stringify(question) }));
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

  /** Each leg's question as last asked, so opening a day asks only about what is new. */
  let asked = new Map<string, string>();

  const check = async (bundle: TripBundle, again: boolean) => {
    if (again) {
      checkedAt = Date.now();
      asked = new Map();
    }
    const questions = liveQuestions(bundle, new Date(), opened()).filter(
      ({ key, question }) => asked.get(key) !== JSON.stringify(question),
    );
    if (!questions.length) return;
    for (const { key, question } of questions) asked.set(key, JSON.stringify(question));
    const boards = await Promise.all(questions.map(({ key, question }) => fetchBoard(key, question)));
    const next = { ...live() };
    questions.forEach(({ key }, index) => {
      const board = boards[index];
      // Offline (undefined), a board fetched earlier this session beats the pulled one.
      if (board) next[key] = board;
      else if (board === null) delete next[key];
    });
    // One update, and none if nothing changed, so open boards don't redraw for nothing.
    if (JSON.stringify(next) !== JSON.stringify(live())) setLive(next);
  };

  if (!hasPagesFunction) return trip;

  // A new trip asks afresh; a newly opened day adds its legs.
  createEffect(on(trip, (bundle) => bundle && void check(bundle, true)));
  createEffect(on(opened, () => {
    const bundle = trip();
    if (bundle) void check(bundle, false);
  }, { defer: true }));

  // A phone left open overnight: tomorrow's leg is today's, and a new
  // tomorrow wants a board.
  const onVisible = () => {
    const bundle = trip();
    if (bundle && document.visibilityState === "visible" && Date.now() - checkedAt > RECHECK_MS) void check(bundle, true);
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
