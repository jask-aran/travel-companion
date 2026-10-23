import type { DepartureBoard, DepartureOption } from "@travel-companion/trip-schema";
import { shiftClock } from "./day-times.js";

/**
 * Which departure a board recommends, shared by the board itself and the
 * day route (the hotel's leave-by time, connections between legs), so they
 * never disagree.
 */

/** Changing trains, or from a train to a train at the same station. */
export const CONNECTION_MINUTES = 5;

export type BoardPick = {
  option: DepartureOption | undefined;
  /** The options worth listing, in departure order, the pick among them. */
  listed: DepartureOption[];
  /** Why the pick isn't what the plan asked for, if it isn't. */
  missed?: string;
};

/**
 * - Leave from a time: the first departure at or after it.
 * - Arrive by a time: the last arrival at or before it.
 * - Arrive within a window (an airport, 3 h to 2 h before the flight): the
 *   board lists from the one arriving closest to the start of the window up
 *   to its end, and recommends that first one.
 *
 * `notBefore` is when the previous ride gets you here: a departure before it
 * can't be made, whatever the plan said.
 */
export function pickDeparture(board: DepartureBoard, notBefore?: string): BoardPick {
  const options = board.options;
  const { kind, time, until } = board.target;
  let option: DepartureOption | undefined;
  let listed = options;
  let missed: string | undefined;

  if (kind === "arrive") {
    const latest = until ?? time;
    const inTime = options.filter((candidate) => candidate.arriveTime <= latest);
    option = inTime.filter((candidate) => candidate.arriveTime <= time).at(-1) ?? inTime[0];
    if (until && option) listed = inTime.slice(inTime.indexOf(option));
    if (!option) {
      option = options[0];
      if (option) missed = `Nothing arrives by ${latest} · first in ${option.arriveTime}`;
    }
  } else {
    option = options.find((candidate) => candidate.departTime >= time);
    if (!option) {
      option = options.at(-1);
      if (option) missed = `Nothing leaves after ${time} · last at ${option.departTime}`;
    }
  }

  if (notBefore && option && option.departTime < notBefore) {
    const reachable = options.find((candidate) => candidate.departTime >= notBefore);
    missed = reachable
      ? `You're here at ${notBefore} · first after is ${reachable.departTime}`
      : `You're here at ${notBefore} · nothing after on this board`;
    option = reachable ?? option;
    if (reachable && !listed.includes(reachable)) listed = options.slice(options.indexOf(reachable));
  }

  return { option, listed, ...(missed ? { missed } : {}) };
}

/** When to set off for an option: boarding, less the walk to it. */
export function leaveFor(option: DepartureOption | undefined): string | undefined {
  if (!option) return undefined;
  return option.walkMinutes ? shiftClock(option.departTime, -option.walkMinutes) : option.departTime;
}

/** When an option has you at the far end, ready for the next ride. */
export function readyAfter(option: DepartureOption | undefined): string | undefined {
  return option && shiftClock(option.arriveTime, CONNECTION_MINUTES);
}
