import { describe, expect, it } from "vitest";
import { SNAPSHOT_PADDING as PAD, mapAreas, readsAsOne, type AreaPoint } from "../apps/web/src/lib/map-areas.js";

// Two towns about 13 km apart, each a few hundred metres across.
const furukawa = [{ lat: 36.2381, lng: 137.1866 }, { lat: 36.2372, lng: 137.1879 }];
const takayama = [
  { lat: 36.1446, lng: 137.2597 }, { lat: 36.1416, lng: 137.2596 }, { lat: 36.1395, lng: 137.2583 },
  { lat: 36.1407, lng: 137.2617 }, { lat: 36.1431, lng: 137.2616 }, { lat: 36.1401, lng: 137.2565 },
];
const W = 380;
const H = 150;

/** What every split must hold: each stop once, areas in route order, each area readable. */
function expectGoodAreas(points: AreaPoint[], areas: number[][]) {
  expect(areas.flat().sort((a, b) => a - b)).toEqual(points.map((_, index) => index));
  expect(areas.map((area) => area[0])).toEqual([...areas.map((area) => area[0])].sort((a, b) => a! - b!));
  for (const area of areas) expect(readsAsOne(area.map((index) => points[index]!), W, H, PAD)).toBe(true);
}

describe("map areas", () => {
  it("keeps a block that reads in one view as one area", () => {
    const pair = [furukawa[0]!, takayama[0]!];
    expect(mapAreas(pair, W, H, PAD)).toEqual([[0, 1]]);
  });

  it("never puts two towns in one area, and every area reads", () => {
    const points = [...furukawa, ...takayama];
    expect(readsAsOne(points, W, H, PAD)).toBe(false);
    const areas = mapAreas(points, W, H, PAD);
    expectGoodAreas(points, areas);
    for (const area of areas) expect(area.every((index) => index < 2) || area.every((index) => index >= 2)).toBe(true);
  });

  it("treats a return visit to the same place as one pin", () => {
    const point = { lat: 35.3, lng: 139.55 };
    expect(readsAsOne([point, point, { lat: 35.31, lng: 139.56 }], W, H, PAD)).toBe(true);
  });

  it("joins a lone stop to its neighbours when they still read together", () => {
    // Just beyond walking reach east of Furukawa, along the map's wide side.
    const points = [{ lat: 36.2381, lng: 137.2066 }, ...furukawa];
    expect(mapAreas(points, W, H, PAD)).toEqual([[0, 1, 2]]);
  });
});
