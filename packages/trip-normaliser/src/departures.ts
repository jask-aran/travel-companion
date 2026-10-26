import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TripBundle } from "../../trip-schema/src/index.js";
import { buildBoards, type CacheEntry, type DepartureRequest, type DepartureReport } from "./departure-boards.js";
import { loadTimetables } from "./timetable-files.js";
import { translateNames } from "./translate.js";

export {
  localClock,
  parseGoogleRoutes,
  parseNavitime,
  type DepartureRequest,
  type DepartureReport,
  type GoogleRoutesResponse,
  type NavitimeResponse,
} from "./departure-boards.js";

/**
 * Departure options for the legs that need them, fetched at pull time and
 * stored on the bundle so they work offline. Google answers for Korea;
 * Google's API has no Japanese transit (its FAQ excludes Japan's partners),
 * so NAVITIME answers for Japan.
 *
 * NAVITIME's marketplace plan allows 500 requests a month and counts failed
 * ones, so answers are cached on disk and reused for a week, and a run
 * stops asking once it has spent its budget.
 */

export type DepartureKeys = {
  google?: string | undefined;
  navitime?: string | undefined;
  /** Google Cloud Translation, for names NAVITIME and Google give in Japanese or Korean. */
  translate?: string | undefined;
  /** The Google Cloud project's number, which selects the Translation LLM. */
  translateProject?: string | undefined;
};

/** Per run; the month allows 500. A full trip is about a dozen legs. */
const NAVITIME_BUDGET = 40;
type Cache = Record<string, CacheEntry>;

async function readCache(path: string): Promise<Cache> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Cache;
  } catch {
    return {};
  }
}

export async function attachDepartures(
  bundle: TripBundle,
  requests: DepartureRequest[],
  keys: DepartureKeys,
  cacheDir: string,
  now = new Date(),
): Promise<DepartureReport> {
  const report: DepartureReport = {
    boards: 0,
    cached: 0,
    requested: { google: 0, navitime: 0 },
    skipped: 0,
    errors: [],
  };
  const cachePath = join(cacheDir, "departures-cache.json");
  const cache = await readCache(cachePath);

  const boards = await buildBoards(bundle, requests, {
    keys,
    cache,
    timetables: loadTimetables(bundle.tripId),
    translate: async (texts) => {
      // Persist provider answers before translating, as at pull time before the split.
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      return translateNames(
        texts,
        keys.translate,
        join(cacheDir, "translations-cache.json"),
        keys.translateProject,
      );
    },
    mayAskNavitime: () => report.requested.navitime < NAVITIME_BUDGET,
    now,
  }, report);
  report.boards = Object.keys(boards).length;
  if (report.boards) bundle.departures = boards;
  return report;
}
