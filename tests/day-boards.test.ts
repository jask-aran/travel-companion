import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Place, TripBundle } from "../packages/trip-schema/src/index.js";
import { buildBoards, type DepartureReport, type DepartureRequest } from "../packages/trip-normaliser/src/departure-boards.js";
import type { CuratedTimetable } from "../packages/trip-normaliser/src/curated-timetables.js";
import { loadTimetables } from "../packages/trip-normaliser/src/timetable-files.js";

/**
 * Boards for legs the plan gives no time ("day"), and boards built from a
 * timetable's own stops when the provider has no route (buses NAVITIME's
 * plan doesn't know).
 */

const navitime = readFileSync(new URL("./fixtures/navitime-narita-shinjuku.json", import.meta.url), "utf8");

const place = (id: string, name: string, latitude: number, longitude: number): Place =>
  ({ id, name, latitude, longitude, timeZone: "Asia/Tokyo" }) as Place;

const places = {
  // A rental in Takayama, ~600 m from the bus centre.
  nad: place("nad", "Nadamachi", 36.1366462, 137.2560481),
  far: place("far", "Somewhere", 36.17, 137.2514),
  shh: place("shh", "Shinhotaka Ropeway", 36.2857919, 137.5752622),
  nrt: place("nrt", "Narita International Airport", 35.7647, 140.3864),
  shinjuku: place("shinjuku", "Shinjuku Granbell Hotel", 35.696445, 139.705724),
};

const context = (estimateMinutes?: number) =>
  ({
    places,
    routeLegs: estimateMinutes
      ? { leg: { id: "leg", fromPlaceId: "nad", toPlaceId: "shh", durationSeconds: estimateMinutes * 60 } }
      : {},
  }) as unknown as Pick<TripBundle, "places" | "routeLegs">;

const stops = (center: string, hirayu: string, ropeway: string) => ({
  "高山濃飛バスセンター": center,
  "平湯温泉": hirayu,
  "新穂高ロープウェイ": ropeway,
});

/** A bus timetable with its stops located, listing every bus of the day. */
const nohi = (extra: Partial<CuratedTimetable> = {}): CuratedTimetable =>
  ({
    id: "test-nohi-takayama-shinhotaka",
    operator: "Nohi Bus",
    service: "Takayama–Shinhotaka Line",
    serviceNames: ["濃飛バス"],
    kind: "bus",
    stationNames: {
      "高山濃飛バスセンター": "Takayama Bus Center",
      "平湯温泉": "Hirayu Onsen",
      "新穂高ロープウェイ": "Shinhotaka Ropeway",
    },
    stopCoordinates: {
      "高山濃飛バスセンター": [36.1408, 137.2522],
      "平湯温泉": [36.1879, 137.56],
      "新穂高ロープウェイ": [36.2864, 137.575],
    },
    allDay: true,
    source: { urls: ["https://example.test/nohi"], retrieved: "2026-10-26", note: "test" },
    departures: [
      { train: "Bus 1", stops: stops("06:50", "07:50", "08:30"), days: "daily" },
      { train: "Bus 2", stops: stops("08:40", "09:40", "10:20"), days: "daily" },
      { train: "Bus 3", stops: stops("11:40", "12:40", "13:20"), days: "weekends" },
      { train: "Bus 4", stops: stops("14:10", "15:10", "15:50"), days: "daily" },
      // The other way: never a ride from Takayama to Shinhotaka.
      { train: "Return 1", stops: { "新穂高ロープウェイ": "15:00", "平湯温泉": "15:40", "高山濃飛バスセンター": "16:40" }, days: "daily" },
    ],
    ...extra,
  }) as CuratedTimetable;

const request = (overrides: Partial<DepartureRequest>): DepartureRequest => ({
  key: "k",
  fromPlaceId: "nad",
  toPlaceId: "shh",
  provider: "navitime",
  kind: "day",
  date: "2026-11-24", // a Tuesday
  time: "05:00",
  ...overrides,
});

const newReport = (): DepartureReport => ({ boards: 0, cached: 0, requested: { google: 0, navitime: 0 }, skipped: 0, errors: [] });

function run(requests: DepartureRequest[], timetables: CuratedTimetable[], options: { navitime?: string; estimate?: number } = {}) {
  const fetchMock = vi.fn(async (url: string) => new Response(options.navitime ?? navitime));
  vi.stubGlobal("fetch", fetchMock);
  const report = newReport();
  const boards = buildBoards(
    context(options.estimate),
    requests,
    {
      keys: { navitime: "nkey" },
      cache: {},
      timetables,
      translate: async () => ({ translations: {} }),
      mayAskNavitime: () => true,
      now: new Date("2026-10-26T00:00:00Z"),
    },
    report,
  );
  return { boards, report, fetchMock };
}

afterEach(() => vi.unstubAllGlobals());

describe("day boards", () => {
  it("lists the day's buses from a located timetable, with the walk to the stop, without asking a provider", async () => {
    const { boards, report, fetchMock } = run([request({})], [nohi()]);
    const board = (await boards).k;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.requested).toEqual({ google: 0, navitime: 0 });
    expect(board?.target).toEqual({ kind: "day", date: "2026-11-24", time: "05:00" });
    expect(board?.approximate).not.toBe(true);
    expect(board?.source).toMatchObject({ type: "curated", operator: "Nohi Bus" });
    // Weekend-only Bus 3 doesn't run on a Tuesday; the return bus goes the other way.
    expect(board?.options.map((option) => option.departTime)).toEqual(["06:50", "08:40", "14:10"]);
    const [first] = board!.options;
    expect(first).toMatchObject({ departTime: "06:50", arriveTime: "08:30", minutes: 100 });
    expect(first?.walkMinutes).toBeGreaterThan(3);
    expect(first?.walkMinutes).toBeLessThan(20);
    expect(first?.segments).toEqual([
      expect.objectContaining({
        name: "Bus 1",
        kind: "bus",
        from: "Takayama Bus Center",
        to: "Shinhotaka Ropeway",
        departTime: "06:50",
        arriveTime: "08:30",
      }),
    ]);
  });

  it("keeps to a timetable's dates", async () => {
    const winter = nohi({ valid: { from: "2026-12-01", to: "2027-03-31" } });
    const { boards } = run([request({})], [winter]);
    expect(await boards).toEqual({});
  });

  it("only boards at stops within walking distance", async () => {
    const { boards } = run([request({ fromPlaceId: "far" })], [nohi()]);
    expect(await boards).toEqual({});
  });

  it("builds a rail day board on the provider's route, from a timetable that lists the whole day", async () => {
    const skyliner = loadTimetables("japan-korea-2026").find((table) => table.id === "keisei-skyliner-narita-city")!;
    const day = request({ fromPlaceId: "nrt", toPlaceId: "shinjuku", date: "2026-12-06" });
    const { boards, report, fetchMock } = run([day], [{ ...skyliner, allDay: true }]);
    const board = (await boards).k;
    // One ask, for the route; the times all come from the timetable.
    expect(report.requested.navitime).toBe(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("start_time=2026-12-06T09%3A00%3A00");
    expect(board?.target.kind).toBe("day");
    expect(board!.options.length).toBeGreaterThan(20);
    const departures = board!.options.map((option) => option.departTime);
    expect(departures).toEqual([...departures].sort());
    expect(board!.options.every((option) => option.segments[0]?.name.startsWith("Skyliner"))).toBe(true);
  });

  it("never makes a day board from estimates or from a timetable that lists only part of the day", async () => {
    const skyliner = loadTimetables("japan-korea-2026").find((table) => table.id === "keisei-skyliner-narita-city")!;
    const day = request({ fromPlaceId: "nrt", toPlaceId: "shinjuku", date: "2026-12-06" });
    expect(await run([day], []).boards).toEqual({});
    expect(await run([day], [skyliner]).boards).toEqual({});
  });

  it("asks Google nothing for a day board", async () => {
    const { boards, fetchMock } = run([request({ provider: "google", fromPlaceId: "nrt", toPlaceId: "shinjuku" })], []);
    expect(await boards).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("boards from a timetable's stops for a timed leg", () => {
  it("are what's left when the provider has no route", async () => {
    const timed = request({ kind: "depart", time: "08:00" });
    const { boards, report } = run([timed], [nohi({ allDay: undefined })], { navitime: JSON.stringify({ items: [] }), estimate: 99 });
    const board = (await boards).k;
    expect(report.requested.navitime).toBe(1);
    expect(board?.target).toEqual({ kind: "depart", date: "2026-11-24", time: "08:00" });
    // The same three-hour window as other timed boards.
    expect(board?.options.map((option) => option.departTime)).toEqual(["08:40"]);
  });

  it("don't replace a route the provider gave", async () => {
    const timed = request({ kind: "depart", time: "13:30", fromPlaceId: "nrt", toPlaceId: "shinjuku", date: "2026-12-06" });
    const nearNarita = nohi({
      stopCoordinates: { "高山濃飛バスセンター": [35.765, 140.386], "平湯温泉": [35.7, 140], "新穂高ロープウェイ": [35.6965, 139.7057] },
    });
    const board = (await run([timed], [nearNarita]).boards).k;
    expect(board?.approximate).toBe(true);
    expect(board?.options.some((option) => option.segments[0]?.kind === "bus")).toBe(false);
  });
});
