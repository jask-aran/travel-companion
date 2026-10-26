import { readdirSync, readFileSync } from "node:fs";
import type { CuratedTimetable } from "./curated-timetables.js";

const timetablesByTrip = new Map<string, CuratedTimetable[]>();

export function loadTimetables(tripId: string): CuratedTimetable[] {
  if (/^[a-z0-9-]+$/.exec(tripId)?.[0] !== tripId) return [];
  const cached = timetablesByTrip.get(tripId);
  if (cached) return cached;

  // `timetables.json`, plus any files in `timetables/` (one per region, so
  // several people or agents can add to a trip without editing one file).
  const folder = new URL(`../../../data/trips/${tripId}/`, import.meta.url);
  const read = (url: URL): CuratedTimetable[] => {
    try {
      return JSON.parse(readFileSync(url, "utf8")) as CuratedTimetable[];
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      return [];
    }
  };
  let extra: string[] = [];
  try {
    extra = readdirSync(new URL("timetables/", folder)).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  const timetables = [
    ...read(new URL("timetables.json", folder)),
    ...extra.flatMap((name) => read(new URL(`timetables/${name}`, folder))),
  ];
  timetablesByTrip.set(tripId, timetables);
  return timetables;
}
