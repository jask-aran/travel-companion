import { describe, expect, it } from "vitest";
import type { Place } from "../packages/trip-schema/src/index.js";
import { stayDisplay } from "../apps/web/src/lib/lodging.js";

const at = (address: string, locality?: string) => ({ address, ...(locality ? { locality } : {}) }) as Place;

describe("a stay named by its street", () => {
  it("goes by its neighbourhood, the street kept under it", () => {
    expect(stayDisplay("1-chōme-21-1 Nipponbashi", at("1-chōme-21-1 Nipponbashi, Chuo Ward, Osaka, 542-0073, Japan"))).toEqual({
      name: "Stay in Nipponbashi",
      street: "1-chōme-21-1 Nipponbashi, Osaka",
    });
  });

  it("falls back to the locality where the street is a numbered road", () => {
    expect(stayDisplay("30-3 Yeonhui-ro 1-gil", at("30-3 Yeonhui-ro 1-gil, Mapo-gu, Seoul, South Korea", "Mapo-gu"))).toEqual({
      name: "Stay in Mapo-gu",
      street: "30-3 Yeonhui-ro 1-gil, Seoul",
    });
  });

  it("keeps a real name, and a number that isn't the address", () => {
    expect(stayDisplay("Shinjuku Granbell Hotel", at("2-chōme-14-5 Kabukichō, Shinjuku City, Tokyo"))).toEqual({ name: "Shinjuku Granbell Hotel" });
    expect(stayDisplay("1 Hotel Tokyo", at("Akasaka, Minato City, Tokyo"))).toEqual({ name: "1 Hotel Tokyo" });
  });
});
