import { describe, expect, it } from "vitest";
import type { Place } from "../packages/trip-schema/src/index.js";
import { providerFor } from "../apps/web/src/lib/departure-targets.js";

const place = (latitude: number, longitude: number, address?: string): Place => ({
  id: "place",
  name: "Place",
  latitude,
  longitude,
  ...(address === undefined ? {} : { address }),
});

describe("providerFor", () => {
  it.each([
    ["Narita", 35.77, 140.38, "navitime"],
    ["Tsushima", 34.2, 129.29, "navitime"],
    ["Busan", 35.1, 129.04, "google"],
    ["Seoul", 37.57, 126.98, "google"],
    ["Paris", 48.85, 2.35, "google"],
    ["Naha, Okinawa", 26.21, 127.68, "navitime"],
    ["Taipei", 25.03, 121.56, "google"],
    ["Sakhalin", 47, 142.7, "google"],
    ["Kunashir, Kurils", 44, 145.8, "google"],
    ["Ulleungdo", 37.5, 130.9, "google"],
    ["Nemuro", 43.33, 145.58, "navitime"],
    ["Fukuoka", 33.59, 130.4, "navitime"],
  ])("selects the provider for %s", (_name, latitude, longitude, provider) => {
    expect(providerFor(place(latitude, longitude))).toBe(provider);
  });

  it.each(["Remote island, Japan", "離島、日本", "Remote island, Japan  "])(
    "uses the Japan address suffix: %s",
    (address) => {
      expect(providerFor(place(27.1, 142.2, address))).toBe("navitime");
    },
  );

  it("returns undefined without both coordinates, even with a Japan address", () => {
    expect(providerFor()).toBeUndefined();
    expect(providerFor({ id: "place", name: "Place", address: "Japan" })).toBeUndefined();
    expect(providerFor({ id: "place", name: "Place", latitude: 35.77 })).toBeUndefined();
    expect(providerFor({ id: "place", name: "Place", longitude: 140.38 })).toBeUndefined();
  });
});
