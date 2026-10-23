import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DepartureBoard, Place, TripBundle } from "../packages/trip-schema/src/index.js";
import {
  parseGoogleRoutes,
  parseNavitime,
  type GoogleRoutesResponse,
  type NavitimeResponse,
} from "../packages/trip-normaliser/src/departures.js";
import { curateDepartureBoard } from "../packages/trip-normaliser/src/curated-timetables.js";
import {
  englishName,
  localHeadsign,
  englishStation,
  localLineName,
  needsTranslation,
  stationQuery,
} from "../packages/trip-normaliser/src/line-names.js";
import { departureTargets, providerFor } from "../apps/web/src/lib/departure-targets.js";

const fixture = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

describe("parseGoogleRoutes", () => {
  it("reads AREX departures from Gimpo, in local time, by departure", () => {
    const options = parseGoogleRoutes(fixture<GoogleRoutesResponse>("google-routes-gimpo.json"));
    expect(options.map((option) => option.departTime)).toEqual(["11:29", "11:33", "11:41", "11:50"]);
    const [first] = options;
    expect(first).toMatchObject({ arriveTime: "11:43", minutes: 14 });
    // Names stay as given; translation is a later, cached step.
    expect(first?.segments[0]).toMatchObject({
      name: "공항철도",
      kind: "subway",
      headsign: "서울역",
      from: "김포공항",
      to: "Hongik Univ. Entrance",
      color: "#0095d4",
    });
  });

  it("drops a bus that leaves earlier but arrives after the train", () => {
    const options = parseGoogleRoutes(fixture<GoogleRoutesResponse>("google-routes-gimpo.json"));
    expect(options.some((option) => option.segments.some((segment) => segment.kind === "bus"))).toBe(false);
  });

  it("counts the walk before the first ride, rounded up to minutes", () => {
    const ride = (dep: string, arr: string) => ({
      travelMode: "TRANSIT",
      transitDetails: {
        stopDetails: { departureTime: dep, arrivalTime: arr },
        transitLine: { name: "AREX", vehicle: { type: "RAIL" } },
      },
    });
    const [option] = parseGoogleRoutes({
      routes: [
        {
          legs: [
            {
              steps: [
                { travelMode: "WALK", staticDuration: "100s" },
                { travelMode: "WALK", staticDuration: "50s" },
                ride("2026-05-01T01:00:00Z", "2026-05-01T01:30:00Z"),
                { travelMode: "WALK", staticDuration: "600s" },
              ],
            },
          ],
        },
      ],
    });
    expect(option?.walkMinutes).toBe(3);
  });
});

describe("parseNavitime", () => {
  it("reads the Narita trains with their kinds and ride times", () => {
    const options = parseNavitime(fixture<NavitimeResponse>("navitime-narita-shinjuku.json"));
    expect(options[0]).toMatchObject({ departTime: "13:44", arriveTime: "14:54", minutes: 70 });
    expect(options[0]?.segments.map((segment) => [segment.name, segment.kind])).toEqual([
      ["京成スカイライナー", "express"],
      ["都営大江戸線", "subway"],
    ]);
    expect(options[0]?.walkMinutes).toBe(4);
  });

  it("keeps only the Hida when slower routes leave earlier and arrive later", () => {
    const options = parseNavitime(fixture<NavitimeResponse>("navitime-nagoya-takayama.json"));
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ departTime: "08:34", arriveTime: "10:55" });
    expect(options[0]?.segments[0]).toMatchObject({ name: "ひだ", from: "名古屋", to: "高山" });
  });

  it("uses published Hida times and keeps the first train even when it misses the target", () => {
    const options = parseNavitime(fixture<NavitimeResponse>("navitime-nagoya-takayama.json"));
    const board = (time: string): DepartureBoard => ({
      provider: "navitime",
      target: { kind: "arrive", date: "2026-11-23", time },
      fetchedAt: "2026-10-23T00:00:00.000Z",
      approximate: true,
      options,
    });

    const onTime = curateDepartureBoard(board("10:30"), "japan-korea-2026");
    expect(onTime.matched).toBe(true);
    expect(onTime.board).toMatchObject({
      approximate: false,
      source: { type: "curated", operator: "JR Central" },
      options: [
        {
          departTime: "07:43",
          arriveTime: "10:16",
          minutes: 153,
          segments: [{ name: "Hida 1", from: "Nagoya", to: "Takayama" }],
        },
        {
          departTime: "08:43",
          arriveTime: "11:03",
          segments: [{ name: "Hida 3" }],
        },
        {
          departTime: "09:39",
          arriveTime: "12:20",
          segments: [{ name: "Hida 5" }],
        },
      ],
    });

    const missesTarget = curateDepartureBoard(board("09:30"), "japan-korea-2026");
    expect(missesTarget.board).toMatchObject({
      approximate: false,
      source: { type: "curated", operator: "JR Central" },
      options: [
        {
          departTime: "07:43",
          arriveTime: "10:16",
          segments: [{ name: "Hida 1" }],
        },
        {
          departTime: "08:43",
          arriveTime: "11:03",
          segments: [{ name: "Hida 3" }],
        },
      ],
    });
  });

  it("leaves the board unchanged for a trip without curated timetables", () => {
    const board: DepartureBoard = {
      provider: "navitime",
      target: { kind: "arrive", date: "2026-11-23", time: "10:30" },
      fetchedAt: "2026-10-23T00:00:00.000Z",
      approximate: true,
      options: parseNavitime(fixture<NavitimeResponse>("navitime-nagoya-takayama.json")),
    };
    const result = curateDepartureBoard(board, "unknown-trip");
    expect(result.matched).toBe(false);
    expect(result.board).toBe(board);
  });

  it("matches composite Skyliner names and ignores terminal detail in station names", () => {
    const result = curateDepartureBoard({
      provider: "navitime",
      target: { kind: "depart", date: "2026-11-21", time: "19:30" },
      fetchedAt: "2026-10-23T00:00:00.000Z",
      approximate: true,
      options: [
        {
          departTime: "19:30",
          arriveTime: "20:10",
          minutes: 40,
          segments: [
            {
              name: "京成スカイライナー 空港第2ビル(成田第2・第3ターミナル)→日暮里",
              kind: "express",
              departTime: "19:30",
              arriveTime: "20:10",
              from: "空港第2ビル(成田第2・第3ターミナル)",
              to: "日暮里",
            },
          ],
        },
      ],
    }, "japan-korea-2026");

    expect(result.board).toMatchObject({ approximate: false, source: { type: "curated", operator: "Keisei" } });
    // Leaving at 19:30, the first train after it leads the board.
    expect(result.board?.options[0]).toMatchObject({
      departTime: "19:43",
      arriveTime: "20:20",
      segments: [{ name: "Skyliner 68", from: "Narita Airport Terminal 2,3", to: "Nippori" }],
    });
  });

  it("shifts a connecting ride to follow a curated Skyliner arrival", () => {
    const [option] = parseNavitime(fixture<NavitimeResponse>("navitime-narita-shinjuku.json"));
    const result = curateDepartureBoard({
      provider: "navitime",
      target: { kind: "depart", date: "2026-12-06", time: "14:05" },
      fetchedAt: "2026-10-23T00:00:00.000Z",
      approximate: true,
      options: [option!],
    }, "japan-korea-2026");

    const skyliner = result.board?.options.find((candidate) => candidate.segments[0]?.name === "Skyliner 136");
    expect(skyliner).toMatchObject({
      departTime: "14:18",
      arriveTime: "15:35",
      segments: [
        { name: "Skyliner 136", departTime: "14:18", arriveTime: "15:10" },
        { name: "都営大江戸線", departTime: "15:21", arriveTime: "15:35" },
      ],
    });
  });
});

describe("line names", () => {
  it("folds full-width letters and drops the stretch NAVITIME appends", () => {
    expect(localLineName("ＪＲ高山本線（岐阜-美濃太田）")).toBe("JR高山本線");
    // A bus's place in brackets is part of its name, not a stretch.
    expect(localLineName("058A(임진각)")).toBe("058A(임진각)");
  });

  it("reads a Korean headsign as its destination", () => {
    expect(localHeadsign("서울역 방면")).toBe("서울역");
    expect(localHeadsign("Incheon International Airport T2-3FL")).toBe("Incheon International Airport T2-3FL");
  });

  it("translates only local scripts, and numbers Seoul Metro lines by rule", () => {
    expect(needsTranslation("京成スカイライナー")).toBe(true);
    expect(needsTranslation("공항철도")).toBe(true);
    expect(needsTranslation("6002")).toBe(false);
    expect(englishName("2호선", {})).toBe("Line 2");
    expect(englishName("공항철도", { 공항철도: "Airport Railroad" })).toBe("Airport Railroad");
    expect(englishName("某線", {})).toBe("某線");
  });

  it("asks for a Japanese station as a station, so it is romanised", () => {
    expect(stationQuery("白子")).toBe("白子駅");
    expect(stationQuery("Hongik Univ. Entrance")).toBe("Hongik Univ. Entrance");
    expect(englishStation("白子", { 白子駅: "Shiroko Station" })).toBe("Shiroko");
    expect(englishStation("白子", {})).toBe("白子");
  });
});

const place = (id: string, latitude: number, longitude: number, name = id): Place =>
  ({ id, name, latitude, longitude }) as Place;

describe("departureTargets", () => {
  it("picks NAVITIME for Japan and Google elsewhere", () => {
    expect(providerFor(place("icn", 37.46, 126.44))).toBe("google");
    expect(providerFor(place("nrt", 35.77, 140.38))).toBe("navitime");
    expect(providerFor(place("cns", -16.88, 145.75))).toBe("google");
  });

  it("times a flight's transfers and a journey pinned by a stop time", () => {
    const leg = (from: string, to: string, minutes: number, travelMode = "transit") => ({
      id: `${from}-${to}`,
      fromPlaceId: from,
      toPlaceId: to,
      travelMode,
      durationSeconds: minutes * 60,
    });
    const bundle = {
      trip: { title: "t", startDate: "2026-12-05", endDate: "2026-12-07" },
      places: {
        hotel: place("hotel", 37.56, 126.92),
        icn: place("icn", 37.46, 126.44),
        nrt: place("nrt", 35.77, 140.38),
        shinjuku: place("shinjuku", 35.69, 139.7),
        nagoya: place("nagoya", 35.17, 136.88),
      },
      routeLegs: {
        a: leg("hotel", "icn", 70),
        b: leg("nrt", "shinjuku", 80),
        c: leg("shinjuku", "nagoya", 100),
      },
      days: [
        {
          id: "d1",
          date: "2026-12-06",
          title: "",
          timezone: "Asia/Seoul",
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
            { id: "s1", type: "place", placeId: "icn" },
            { id: "s2", type: "place", placeId: "nrt" },
            { id: "s3", type: "place", placeId: "shinjuku", endTime: "16:00" },
            { id: "s4", type: "place", placeId: "nagoya" },
          ],
        },
      ],
    } as unknown as TripBundle;

    const targets = departureTargets(bundle).map(({ key, provider, kind, date, time }) => ({
      key,
      provider,
      kind,
      date,
      time,
    }));
    expect(targets).toEqual([
      // Out of the arrival airport, 90 minutes after an international landing.
      { key: "nrt>shinjuku", provider: "navitime", kind: "depart", date: "2026-12-06", time: "14:20" },
      // A journey leaves when the stop before it ends.
      { key: "shinjuku>nagoya", provider: "navitime", kind: "depart", date: "2026-12-06", time: "16:00" },
    ]);
  });
});
