import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Place, TripBundle } from "../packages/trip-schema/src/index.js";
import {
  parseGoogleRoutes,
  parseNavitime,
  type GoogleRoutesResponse,
  type NavitimeResponse,
} from "../packages/trip-normaliser/src/departures.js";
import { englishHeadsign, englishLineName } from "../packages/trip-normaliser/src/line-names.js";
import { departureTargets, providerFor } from "../apps/web/src/lib/departure-targets.js";

const fixture = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

describe("parseGoogleRoutes", () => {
  it("reads AREX departures from Gimpo, in local time, by departure", () => {
    const options = parseGoogleRoutes(fixture<GoogleRoutesResponse>("google-routes-gimpo.json"));
    expect(options.map((option) => option.departTime)).toEqual(["11:29", "11:33", "11:41", "11:50"]);
    const [first] = options;
    expect(first).toMatchObject({ arriveTime: "11:43", minutes: 14 });
    expect(first?.segments[0]).toMatchObject({
      name: "AREX",
      nameLocal: "공항철도",
      kind: "subway",
      headsign: "Seoul Station",
      color: "#0095d4",
    });
  });

  it("drops a bus that leaves earlier but arrives after the train", () => {
    const options = parseGoogleRoutes(fixture<GoogleRoutesResponse>("google-routes-gimpo.json"));
    expect(options.some((option) => option.segments.some((segment) => segment.kind === "bus"))).toBe(false);
  });
});

describe("parseNavitime", () => {
  it("names the Narita trains in English and keeps the Japanese", () => {
    const options = parseNavitime(fixture<NavitimeResponse>("navitime-narita-shinjuku.json"));
    expect(options[0]).toMatchObject({ departTime: "13:44", arriveTime: "14:54", minutes: 70 });
    expect(options[0]?.segments.map((segment) => [segment.name, segment.kind])).toEqual([
      ["Keisei Skyliner", "express"],
      ["Toei Oedo Line", "subway"],
    ]);
    expect(options.flatMap((option) => option.segments.map((segment) => segment.name))).toContain(
      "Narita Express",
    );
  });

  it("keeps only the Hida when slower routes leave earlier and arrive later", () => {
    const options = parseNavitime(fixture<NavitimeResponse>("navitime-nagoya-takayama.json"));
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ departTime: "08:34", arriveTime: "10:55" });
    expect(options[0]?.segments[0]?.name).toBe("Hida");
  });
});

describe("line names", () => {
  it("prefers the specific service over its operator", () => {
    expect(englishLineName("京成スカイライナー").name).toBe("Keisei Skyliner");
    expect(englishLineName("名鉄犬山線特急").name).toBe("Meitetsu Inuyama Line");
  });

  it("drops the stretch NAVITIME appends and folds full-width letters", () => {
    expect(englishLineName("ＪＲ高山本線（岐阜-美濃太田）")).toEqual({
      name: "JR Takayama Line",
      nameLocal: "JR高山本線(岐阜-美濃太田)",
    });
  });

  it("numbers Seoul Metro lines and passes unknown names through", () => {
    expect(englishLineName("2호선").name).toBe("Line 2");
    expect(englishLineName("058A(임진각)").name).toBe("058A (Imjingak)");
    expect(englishLineName("某線")).toEqual({ name: "某線" });
  });

  it("reads a Korean headsign as its destination", () => {
    expect(englishHeadsign("서울역 방면")).toBe("Seoul Station");
    expect(englishHeadsign("Incheon International Airport T2-3FL")).toBe(
      "Incheon International Airport T2-3FL",
    );
  });
});

const place = (id: string, latitude: number, longitude: number, name = id): Place =>
  ({ id, name, latitude, longitude }) as Place;

describe("departureTargets", () => {
  it("picks Google for Korea and NAVITIME for Japan", () => {
    expect(providerFor(place("icn", 37.46, 126.44))).toBe("google");
    expect(providerFor(place("nrt", 35.77, 140.38))).toBe("navitime");
    expect(providerFor(place("cns", -16.88, 145.75))).toBeUndefined();
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
      // Out of the arrival airport, 45 minutes after landing.
      { key: "nrt>shinjuku", provider: "navitime", kind: "depart", date: "2026-12-06", time: "13:35" },
      // A journey leaves when the stop before it ends.
      { key: "shinjuku>nagoya", provider: "navitime", kind: "depart", date: "2026-12-06", time: "16:00" },
    ]);
  });
});
