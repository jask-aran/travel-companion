import { describe, expect, it } from "vitest";
import type { DepartureBoard, Place, TripBundle } from "../packages/trip-schema/src/index.js";
import { liveQuestions } from "../apps/web/src/lib/live-departures.js";
import { departureTargets } from "../apps/web/src/lib/departure-targets.js";
import { pickDeparture } from "../apps/web/src/lib/departure-pick.js";
import {
  LATER_LIFETIME_MS,
  SOON_LIFETIME_MS,
  boardLifetimeMs,
  boardQuestion,
  localDate,
  readBoardQuestion,
} from "../apps/web/src/lib/departures-api.js";

const place = (id: string, latitude: number, longitude: number): Place =>
  ({ id, name: `${id} Station`, latitude, longitude, timeZone: "Asia/Tokyo", photo: { name: "places/x/photos/y" } }) as Place;

const leg = (from: string, to: string, minutes: number) => ({
  id: `${from}-${to}`,
  fromPlaceId: from,
  toPlaceId: to,
  travelMode: "transit",
  durationSeconds: minutes * 60,
});

/** A Narita landing on 6 Dec, a ride into Shinjuku, and a pinned journey on to Nagoya. */
const trip = (departures?: Record<string, DepartureBoard>) =>
  ({
    trip: { title: "t", startDate: "2026-12-05", endDate: "2026-12-07" },
    places: {
      icn: { ...place("icn", 37.46, 126.44), timeZone: "Asia/Seoul" },
      nrt: place("nrt", 35.77, 140.38),
      shinjuku: place("shinjuku", 35.69, 139.7),
      nagoya: place("nagoya", 35.17, 136.88),
    },
    routeLegs: { b: leg("nrt", "shinjuku", 80), c: leg("shinjuku", "nagoya", 100) },
    days: [
      {
        id: "d1",
        date: "2026-12-06",
        title: "",
        timezone: "Asia/Tokyo",
        items: [
          {
            id: "f1",
            type: "flight",
            departDate: "2026-12-06",
            departTime: "10:25",
            arriveDate: "2026-12-06",
            arriveTime: "12:50",
            departPlaceId: "icn",
            arrivePlaceId: "nrt",
          },
          { id: "s2", type: "place", placeId: "nrt" },
          { id: "s3", type: "place", placeId: "shinjuku", endTime: "16:00" },
          { id: "s4", type: "place", placeId: "nagoya" },
        ],
      },
    ],
    ...(departures ? { departures } : {}),
  }) as unknown as TripBundle;

const pulled = (kind: "arrive" | "depart", date: string, time: string): DepartureBoard =>
  ({ provider: "navitime", target: { kind, date, time }, fetchedAt: "2026-10-26T00:00:00Z", options: [] }) as DepartureBoard;

const keys = (bundle: TripBundle, now: string) => liveQuestions(bundle, new Date(now)).map((entry) => entry.key);

describe("live departure boards", () => {
  it("asks about today's and tomorrow's legs, even with a pulled board", () => {
    const bundle = trip({ "nrt>shinjuku": pulled("depart", "2026-12-06", "14:20") });
    // 19:00 on the 5th in Tokyo: the 6th is tomorrow there.
    expect(keys(bundle, "2026-12-05T10:00:00Z")).toEqual(["nrt>shinjuku", "shinjuku>nagoya"]);
    // 08:00 on the 6th: today.
    expect(keys(bundle, "2026-12-05T23:00:00Z")).toEqual(["nrt>shinjuku", "shinjuku>nagoya"]);
  });

  it("for a later day, asks only where the pull has no board for the leg as it now stands", () => {
    const now = "2026-11-01T00:00:00Z";
    expect(keys(trip({ "nrt>shinjuku": pulled("depart", "2026-12-06", "14:20") }), now)).toEqual(["shinjuku>nagoya"]);
    // The stop moved since the pull: its board answers another question.
    expect(keys(trip({ "nrt>shinjuku": pulled("depart", "2026-12-06", "13:00") }), now)).toEqual([
      "nrt>shinjuku",
      "shinjuku>nagoya",
    ]);
  });

  it("leaves past days alone", () => {
    expect(keys(trip(), "2026-12-07T01:00:00Z")).toEqual([]);
  });

  it("sends what a board needs, in one order, and reads it back the same", () => {
    const [entry] = liveQuestions(trip(), new Date("2026-12-05T10:00:00Z"));
    expect(entry?.question).toEqual({
      provider: "navitime",
      kind: "depart",
      date: "2026-12-06",
      time: "14:20",
      from: { id: "nrt", name: "nrt Station", latitude: 35.77, longitude: 140.38, timeZone: "Asia/Tokyo" },
      to: { id: "shinjuku", name: "shinjuku Station", latitude: 35.69, longitude: 139.7, timeZone: "Asia/Tokyo" },
      estimateSeconds: 4800,
    });
    const text = JSON.stringify(entry!.question);
    expect(JSON.stringify(readBoardQuestion(text))).toBe(text);
    // Extra fields don't change the question, so they can't split the stored board.
    const padded = JSON.stringify({ extra: 1, ...entry!.question, from: { ...entry!.question.from, notes: "x" } });
    expect(JSON.stringify(readBoardQuestion(padded))).toBe(text);
  });

  it("refuses anything that isn't a question", () => {
    const question = boardQuestion(
      { key: "k", fromPlaceId: "nrt", toPlaceId: "shinjuku", provider: "navitime", kind: "depart", date: "2026-12-06", time: "14:20" },
      trip(),
    )!;
    const with_ = (change: Record<string, unknown>) => JSON.stringify({ ...question, ...change });
    expect(readBoardQuestion(null)).toBeUndefined();
    expect(readBoardQuestion("not json")).toBeUndefined();
    expect(readBoardQuestion(with_({ provider: "other" }))).toBeUndefined();
    expect(readBoardQuestion(with_({ date: "06/12/2026" }))).toBeUndefined();
    expect(readBoardQuestion(with_({ time: "25:00" }))).toBeUndefined();
    expect(readBoardQuestion(with_({ from: { ...question.from, latitude: 200 } }))).toBeUndefined();
    expect(readBoardQuestion(with_({ to: { ...question.to, timeZone: "../../etc" } }))).toBeUndefined();
    expect(readBoardQuestion(with_({ from: { ...question.from, name: "x".repeat(3000) } }))).toBeUndefined();
  });

  it("keeps a soon board half a day and a later one a week", () => {
    const from = { timeZone: "Asia/Seoul" };
    const now = new Date("2026-12-01T15:30:00Z"); // 00:30 on the 2nd in Seoul
    expect(localDate(from, now)).toBe("2026-12-02");
    expect(boardLifetimeMs({ date: "2026-12-03", from }, now)).toBe(SOON_LIFETIME_MS);
    expect(boardLifetimeMs({ date: "2026-12-04", from }, now)).toBe(LATER_LIFETIME_MS);
    expect(localDate({ utcOffsetMinutes: 540 }, now)).toBe("2026-12-02");
  });
});

describe("day boards in the app", () => {
  const untimed = () =>
    ({
      ...trip(),
      places: {
        tky: place("tky", 36.1411, 137.2514),
        shh: place("shh", 36.2858, 137.5753),
      },
      routeLegs: { a: leg("tky", "shh", 99) },
      days: [
        {
          id: "d1",
          date: "2026-11-23",
          title: "",
          timezone: "Asia/Tokyo",
          items: [
            { id: "s1", type: "place", placeId: "tky" },
            { id: "s2", type: "place", placeId: "shh" },
          ],
        },
      ],
    }) as unknown as TripBundle;

  it("gives a long journey with no time a board for the whole day", () => {
    expect(departureTargets(untimed())).toEqual([
      { key: "tky>shh", fromPlaceId: "tky", toPlaceId: "shh", provider: "navitime", kind: "day", date: "2026-11-23", time: "05:00" },
    ]);
  });

  const day = (...departs: string[]): DepartureBoard =>
    ({
      provider: "navitime",
      target: { kind: "day", date: "2026-11-23", time: "05:00" },
      fetchedAt: "2026-10-26T00:00:00Z",
      options: departs.map((departTime) => ({ departTime, arriveTime: "23:00", minutes: 60, segments: [] })),
    }) as unknown as DepartureBoard;

  it("picks the first bus you can catch, else the day's first, and misses only the last", () => {
    const board = day("06:50", "08:40", "14:10");
    expect(pickDeparture(board).option?.departTime).toBe("06:50");
    expect(pickDeparture(board).missed).toBeUndefined();
    expect(pickDeparture(board, "08:00").option?.departTime).toBe("08:40");
    expect(pickDeparture(board, "08:00").listed.map((option) => option.departTime)).toEqual(["08:40", "14:10"]);
    expect(pickDeparture(board, "08:00").missed).toBeUndefined();
    expect(pickDeparture(board, "15:00")).toMatchObject({
      option: { departTime: "14:10" },
      missed: "Nothing after 15:00 today · last at 14:10",
    });
  });
});
