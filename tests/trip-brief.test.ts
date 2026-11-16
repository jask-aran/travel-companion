import { describe, expect, it } from "vitest";
import type { TripBundle } from "../packages/trip-schema/src/index.js";
import { dayBrief, tripBookings, tripBrief, tripDates, tripOverview } from "../packages/trip-brief/src/index.js";

function bundle(): TripBundle {
  return {
    schemaVersion: 1,
    tripId: "t",
    revision: "r",
    generatedAt: "2026-01-01T00:00:00.000Z",
    trip: { title: "Test Trip", startDate: "2026-03-02", endDate: "2026-03-03" },
    days: [
      {
        id: "day-2026-03-03",
        date: "2026-03-03",
        title: "Town B",
        timezone: "Asia/Seoul",
        items: [
          {
            id: "f1",
            type: "flight",
            airline: "Test Air",
            airlineCode: "TA",
            flightNumber: "12",
            departAirport: "AAA",
            arriveAirport: "BBB",
            departCity: "Alpha",
            arriveCity: "Beta",
            departDate: "2026-03-03",
            departTime: "14:00",
            arriveDate: "2026-03-03",
            arriveTime: "16:30",
            confirmationNumber: "FLYREF1",
            travellerNames: ["Pat Example", "Sam Example"],
            bookingEmailSubject: "Your e-ticket TA12",
            notes: "For Pat Example and Sam Example",
          },
          {
            id: "l1-out",
            type: "lodging",
            name: "Hotel One",
            placeId: "google-place:hotel",
            checkInDate: "2026-03-02",
            checkOutDate: "2026-03-03",
            phase: "check-out",
            sourceBlockId: 7,
          },
        ],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
      {
        id: "day-2026-03-02",
        date: "2026-03-02",
        title: "Town A",
        timezone: "Asia/Tokyo",
        items: [
          {
            id: "l1",
            type: "lodging",
            name: "Hotel One",
            placeId: "google-place:hotel",
            checkInDate: "2026-03-02",
            checkOutDate: "2026-03-03",
            phase: "check-in",
            confirmationNumber: "HOTELREF9",
            travellerNames: ["Pat Example"],
            cancellationDeadline: "2026-02-28 23:59",
            cancellationPolicy: "Free until the deadline.\nThen one night.",
            guests: { adultCount: 2, roomCount: 1, childrenAges: [] },
            bookingEmailSubject: "Booking confirmed: Hotel One",
            startTime: "15:00",
            sourceBlockId: 7,
          },
          { id: "p1", type: "place", placeId: "google-place:museum", startTime: "10:00", endTime: "12:00", notes: "**Buy tickets**\n\n- line one\n- line two" },
          { id: "n1", type: "note", text: "Lunch somewhere" },
          { id: "p2", type: "place", placeId: "google-place:station" },
        ],
        map: { orderedPlaceIds: [], routeLegIds: [] },
      },
    ],
    places: {
      "google-place:hotel": { id: "google-place:hotel", name: "Hotel One", address: "1 Hotel St, Town A", latitude: 35, longitude: 139, googlePlaceId: "ChHotel" },
      "google-place:museum": {
        id: "google-place:museum",
        name: "Test Museum",
        category: "museum",
        address: "2 Museum Rd, Town A",
        locality: "Town A",
        latitude: 35.01,
        longitude: 139.01,
        googlePlaceId: "ChMuseum",
        photo: { name: "places/x/photos/SECRETPHOTO" },
        image: { source: "wanderlog", url: "https://img.example/IMAGEURL.jpg" },
        // 2026-03-02 is a Monday (day 1).
        details: { openingPeriods: [{ day: 1, open: "09:00", close: "17:00" }] },
      },
      "google-place:station": { id: "google-place:station", name: "Central Station", category: "train_station" },
    },
    routeLegs: {
      "route:a": { id: "route:a", fromPlaceId: "google-place:hotel", toPlaceId: "google-place:museum", travelMode: "walking", durationSeconds: 600, distanceMetres: 800, encodedPolyline: "POLYLINEDATA" },
      "route:b": { id: "route:b", fromPlaceId: "google-place:museum", toPlaceId: "google-place:station", travelMode: "transit", durationSeconds: 1500, distanceMetres: 9000 },
      "route:c": { id: "route:c", fromPlaceId: "google-place:station", toPlaceId: "google-place:hotel", travelMode: "walking", durationSeconds: 300, distanceMetres: 400 },
    },
    departures: {
      "google-place:museum>google-place:station": {
        provider: "navitime",
        target: { kind: "depart", date: "2026-03-02", time: "12:00" },
        fetchedAt: "2026-01-01T00:00:00.000Z",
        options: [
          { departTime: "12:10", arriveTime: "12:35", minutes: 25, walkMinutes: 3, segments: [{ name: "Red Line", nameLocal: "赤線", kind: "subway", departTime: "12:10", arriveTime: "12:35" }] },
          {
            departTime: "12:20",
            arriveTime: "12:50",
            minutes: 30,
            segments: [
              { name: "Blue Line", kind: "subway", departTime: "12:20", arriveTime: "12:30" },
              { name: "Green Line", kind: "rail", departTime: "12:35", arriveTime: "12:50" },
            ],
          },
        ],
      },
    },
  };
}

describe("trip brief", () => {
  it("has a header with title, range, generation time and the time-zone note", () => {
    expect(tripDates(bundle())).toEqual(["2026-03-02", "2026-03-03"]);
    const text = tripBrief(bundle());
    expect(text.startsWith("# Test Trip\n")).toBe(true);
    expect(text).toContain("2026-03-02 to 2026-03-03");
    expect(text).toContain("2026-01-01T00:00:00.000Z");
    expect(text).toMatch(/local clock times/);
    // Days in date order whatever the bundle order.
    expect(text.indexOf("(2026-03-02)")).toBeLessThan(text.indexOf("(2026-03-03)"));
  });

  it("renders a day with stops, legs, details and notes intact", () => {
    const text = dayBrief(bundle(), "2026-03-02")!;
    expect(text).toContain("## Mon 2 Mar 2026 (2026-03-02) — Town A");
    expect(text).toContain("Time zone: Asia/Tokyo");
    expect(text).toContain("10:00–12:00 Test Museum");
    expect(text).toContain("Museum · 2 Museum Rd, Town A · Town A");
    expect(text).toContain("Hours that day: 09:00–17:00");
    expect(text).toContain("    **Buy tickets**\n\n    - line one\n    - line two");
    expect(text).toContain("Lunch somewhere");
    // Day one starts at the airport, not a hotel, so nothing leads into the first stop.
    expect(text).not.toContain("Walk Hotel One to Test Museum");
    expect(text).toContain("- → Transit Test Museum to Central Station: 25 min, 9.0 km (lines: Red Line (赤線), Blue Line, Green Line)");
    expect(text).toContain("- → Walk Central Station to Hotel One: 5 min, 400 m");
    expect(text).toContain("https://www.google.com/maps/search/?api=1");
    // Stops in plan order, each leg just before the stop it leads into.
    const order = ["Test Museum\n", "Transit Test Museum", "Central Station\n"].map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("lists a departure board with changes and the suggested option", () => {
    const text = dayBrief(bundle(), "2026-03-02")!;
    expect(text).toContain("Departures (leave from 12:00):");
    expect(text).toContain("- 12:10→12:35 (25 min, 3 min walk first, 0 changes): Red Line [suggested]");
    expect(text).toContain("- 12:20→12:50 (30 min, 1 change): Blue Line, then Green Line");
  });

  it("keeps booking references and travellers for lodging and flights", () => {
    const first = dayBrief(bundle(), "2026-03-02")!;
    expect(first).toContain("Check in: Hotel One");
    expect(first).toContain("Booking reference: HOTELREF9");
    expect(first).toContain("Travellers: Pat Example");
    expect(first).toContain("(1 night)");

    const second = dayBrief(bundle(), "2026-03-03")!;
    expect(second).toContain("Flight TA 12 (Test Air): Alpha (AAA) 2026-03-03 14:00 → Beta (BBB) 2026-03-03 16:30");
    expect(second).toContain("Booking reference: FLYREF1");
    expect(second).toContain("Travellers: Pat Example, Sam Example");
    // A note that only restates the travellers is dropped.
    expect(second).not.toContain("For Pat Example");
    expect(second).toContain("Time zone: Asia/Seoul");
    expect(second).toContain('  Booking email subject: "Your e-ticket TA12"');

    expect(first).toContain("  Guests: 2 adults, 1 room");
    expect(first).toContain("  Free cancellation deadline: 2026-02-28 23:59 (hotel local time)");
    expect(first).toContain("  Cancellation policy: Free until the deadline. Then one night.");
    expect(first).toContain('  Booking email subject: "Booking confirmed: Hotel One"');
  });

  it("never leaks place ids, polylines, photos, images or item ids", () => {
    const text = tripBrief(bundle());
    for (const leak of ["google-place:", "POLYLINEDATA", "SECRETPHOTO", "IMAGEURL", "route:", "day-2026", "l1-out"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("gives a run of days in order, and nothing for a bad run", () => {
    const b = bundle();
    expect(dayBrief(b, "2026-03-02", "2026-03-02")).toBe(dayBrief(b, "2026-03-02"));
    const run = dayBrief(b, "2026-03-02", "2026-03-03")!;
    expect(run).toBe(`${dayBrief(b, "2026-03-02")!.trimEnd()}\n\n${dayBrief(b, "2026-03-03")}`);
    expect(dayBrief(b, "2026-03-09")).toBeUndefined();
    expect(dayBrief(b, "2026-03-03", "2026-03-02")).toBeUndefined();
    expect(dayBrief(b, "2026-03-02", "2026-03-09")).toBeUndefined();
    expect(dayBrief(b, "2026-03-09", "2026-03-03")).toBeUndefined();
  });

  it("has an overview with one line per day and pointers to the other tools", () => {
    const text = tripOverview(bundle());
    expect(text.startsWith("# Test Trip\n")).toBe(true);
    expect(text).toMatch(/local clock times/);
    expect(text).toContain("- Mon 2 Mar (2026-03-02) — Town A; sleep at Hotel One; 2 stops");
    expect(text).toContain("- Tue 3 Mar (2026-03-03) — Town B; 0 stops; flight TA 12 Alpha→Beta 14:00");
    expect(text).toContain("`get_day`");
    expect(text).toContain("`get_bookings`");
    expect(text).not.toContain("HOTELREF9");
  });

  it("lists every flight and stay once, in date order, with all booking data", () => {
    const text = tripBookings(bundle());
    expect(text.match(/- Stay: Hotel One/g)).toHaveLength(1);
    expect(text.match(/- Flight TA 12/g)).toHaveLength(1);
    expect(text.indexOf("- Stay: Hotel One")).toBeLessThan(text.indexOf("- Flight TA 12"));
    for (const fact of [
      "Check in Mon 2 Mar (2026-03-02) from 15:00; check out",
      "(2026-03-03); 1 night",
      "Booking reference: HOTELREF9",
      "Booking reference: FLYREF1",
      "Travellers: Pat Example, Sam Example",
      "Guests: 2 adults, 1 room",
      "1 Hotel St, Town A",
    ]) {
      expect(text).toContain(fact);
    }
  });
});
