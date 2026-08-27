import { describe, expect, it } from "vitest";
import type { DayItem, FlightItem } from "../packages/trip-schema/src/index.js";
import { bindFlights } from "../apps/web/src/lib/flight-binding.js";

const stop = (id: string, placeId: string) => ({ id, type: "place", placeId }) as DayItem;

const flight = (partial: Partial<FlightItem>) =>
  ({ id: "f1", type: "flight", ...partial }) as FlightItem;

describe("binding flights onto a day's stops", () => {
  it("places a flight between two consecutive airport stops", () => {
    const stops = [stop("kix", "p:kix"), stop("gmp", "p:gmp"), stop("hotel", "p:hotel")];
    const b = bindFlights(stops, [flight({ departPlaceId: "p:kix", arrivePlaceId: "p:gmp" })]);

    expect(b.before.get("gmp")?.id).toBe("f1");
    expect(b.after.size).toBe(0);
    expect(b.unbound).toHaveLength(0);
  });

  it("supersedes the invented ground route between the two airports", () => {
    const stops = [stop("kix", "p:kix"), stop("gmp", "p:gmp")];
    const b = bindFlights(stops, [flight({ departPlaceId: "p:kix", arrivePlaceId: "p:gmp" })]);

    expect(b.supersededLegs.has("gmp")).toBe(true);
  });

  it("draws an arrival above the stop when only the arrival airport is in the day", () => {
    const stops = [stop("nrt", "p:nrt"), stop("tokyo", "p:tokyo")];
    const b = bindFlights(stops, [flight({ departPlaceId: "p:cns", arrivePlaceId: "p:nrt" })]);

    expect(b.before.get("nrt")?.id).toBe("f1");
    expect(b.supersededLegs.has("nrt")).toBe(true);
  });

  it("draws a departure below the stop when only the departure airport is in the day", () => {
    const stops = [stop("tokyo", "p:tokyo"), stop("nrt", "p:nrt")];
    const b = bindFlights(stops, [flight({ departPlaceId: "p:nrt", arrivePlaceId: "p:cns" })]);

    expect(b.after.get("nrt")?.id).toBe("f1");
    expect(b.before.size).toBe(0);
  });

  it("supersedes the onward ground route after flying out of a mid-day stop", () => {
    const stops = [stop("nrt", "p:nrt"), stop("later", "p:later")];
    const b = bindFlights(stops, [flight({ departPlaceId: "p:nrt", arrivePlaceId: "p:cns" })]);

    expect(b.supersededLegs.has("later")).toBe(true);
  });

  it("leaves a flight unbound when neither airport is a stop", () => {
    const b = bindFlights(
      [stop("a", "p:a")],
      [flight({ departPlaceId: "p:mel", arrivePlaceId: "p:cns" })],
    );

    expect(b.unbound).toHaveLength(1);
    expect(b.before.size + b.after.size).toBe(0);
  });
});
