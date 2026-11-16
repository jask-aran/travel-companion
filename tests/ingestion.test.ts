import { describe, expect, it } from "vitest";
import { parseWanderlogSource } from "../packages/wanderlog-import/src/index.js";
import { localityFrom, normaliseWanderlog } from "../packages/trip-normaliser/src/index.js";
import { normaliseCompleteWanderlog } from "../packages/trip-normaliser/src/complete.js";

const source = {
  success: true,
  tripPlan: {
    key: "example-trip",
    title: "Example trip",
    startDate: "2026-11-21",
    endDate: "2026-11-22",
    itinerary: {
      sections: [
        {
          id: 1,
          date: "2026-11-21",
          heading: "Tokyo",
          blocks: [
            {
              id: 10,
              type: "place",
              startTime: "09:00",
              imageKeys: ["wanderlog-image-key"],
              place: {
                name: "Tokyo Station",
                place_id: "google-tokyo-station",
                formatted_address: "1 Chome Marunouchi, Tokyo",
                geometry: { location: { lat: 35.6812, lng: 139.7671 } },
                rating: 4.2,
                user_ratings_total: 100,
              },
              text: { ops: [{ insert: "Meet beside the central exit\n" }] },
            },
            {
              id: 11,
              type: "note",
              text: { ops: [{ insert: "Take the shinkansen\n" }] },
            },
            {
              id: 12,
              type: "place",
              place: {
                name: "Nagoya Station",
                place_id: "google-nagoya-station",
                geometry: { location: { lat: 35.1709, lng: 136.8815 } },
                photo_urls: ["https://example.test/nagoya.jpg"],
              },
              text: { ops: [{ insert: "\n" }] },
            },
          ],
        },
      ],
    },
  },
  resources: {
    distancesBetweenPlaces: {
      route: {
        fromPlaceId: "google-tokyo-station",
        toPlaceId: "google-nagoya-station",
        travelMode: "transit",
        route: {
          distance: { value: 350000 },
          duration: { value: 7200 },
          polyline: "encoded",
        },
      },
    },
  },
};

describe("Wanderlog source", () => {
  it("parses the API's JSON object and rejects anything else", () => {
    expect(parseWanderlogSource(JSON.stringify(source)).data.tripPlan).toBeDefined();
    expect(() => parseWanderlogSource("[]")).toThrow();
  });
});

describe("normaliser", () => {
  it.each([
    ["Paris in winter", 48.85, 2.35, "2026-12-01", "Europe/Paris", 60],
    ["Paris in summer", 48.85, 2.35, "2026-07-01", "Europe/Paris", 120],
    ["Kathmandu", 27.7, 85.32, "2026-12-01", "Asia/Kathmandu", 345],
  ])("puts a day in %s on its local clock, from coordinates", (_label, lat, lng, date, zone, offset) => {
    const input = {
      tripPlan: {
        title: "Zones",
        startDate: date,
        endDate: date,
        itinerary: {
          sections: [
            { date, blocks: [{ id: 1, type: "place", place: { place_id: "here", name: "Here", geometry: { location: { lat, lng } } } }] },
          ],
        },
      },
    };
    const { bundle } = normaliseWanderlog(input, { sourceText: JSON.stringify(input) });
    expect(bundle.places["google-place:here"]?.timeZone).toBe(zone);
    expect(bundle.days[0]).toMatchObject({ timezone: zone, utcOffsetMinutes: offset });
  });

  it("creates an allow-listed TripBundle", () => {
    const text = JSON.stringify(source);
    const { bundle, report } = normaliseWanderlog(source, {
      sourceText: text,
      generatedAt: "2026-07-26T00:00:00.000Z",
    });

    expect(bundle.trip.title).toBe("Example trip");
    expect(bundle.days).toHaveLength(1);
    expect(bundle.days[0]?.timezone).toBe("Asia/Tokyo");
    expect(bundle.days[0]?.utcOffsetMinutes).toBe(540);
    expect(bundle.days[0]?.items).toHaveLength(3);
    expect(Object.keys(bundle.places)).toHaveLength(2);
    expect(Object.keys(bundle.routeLegs)).toHaveLength(1);
    expect(bundle.places["google-place:google-nagoya-station"]?.image?.url).toBe("https://example.test/nagoya.jpg");
    expect(report.redacted).toContain("reservation attachments");
  });

  it("applies source-keyed overrides", () => {
    const { bundle } = normaliseWanderlog(source, {
      sourceText: JSON.stringify(source),
      overrides: {
        places: {
          "source-block:10": { displayName: "Central Station", publishAddress: false },
        },
        items: {
          "source-block:10": { status: "tentative", startTime: "10:00" },
        },
      },
    });

    const place = bundle.places["google-place:google-tokyo-station"];
    expect(place?.name).toBe("Central Station");
    expect(place?.address).toBeUndefined();
    expect(bundle.days[0]?.items[0]).toMatchObject({ startTime: "10:00", status: "tentative" });
  });
});

describe("booking details", () => {
  const email = (id: number, subject: string) => ({ type: "email", id, subject, rating: "positive" });
  const bookings = {
    tripPlan: {
      key: "booked",
      title: "Booked",
      startDate: "2026-11-21",
      endDate: "2026-11-23",
      itinerary: {
        sections: [
          { date: "2026-11-21", blocks: [] },
          { date: "2026-11-22", blocks: [] },
          { date: "2026-11-23", blocks: [] },
          {
            type: "hotels",
            blocks: [
              {
                id: 50,
                type: "place",
                addedBy: { type: "user", userId: 999 },
                emailId: 7001,
                cancellationDeadline: "2026-11-18 23:59",
                cancellationPolicy: "Free cancellation until the deadline.",
                guests: { adultCount: 2, roomCount: 1, childrenAges: [] },
                attachments: [email(7001, "Your booking is confirmed"), email(7002, "Other mail")],
                hotel: { checkIn: "2026-11-21", checkOut: "2026-11-23", confirmationNumber: "H123", travelerNames: ["A Traveller"] },
                place: { place_id: "hotel", name: "Example Hotel", geometry: { location: { lat: 35.68, lng: 139.76 } } },
              },
              {
                id: 51,
                type: "place",
                attachments: [],
                hotel: { checkIn: "2026-11-22", checkOut: "2026-11-23" },
                place: { place_id: "plain", name: "Plain Inn", geometry: { location: { lat: 35.68, lng: 139.76 } } },
              },
            ],
          },
          {
            type: "flights",
            blocks: [
              {
                id: 60,
                type: "flight",
                emailId: 8001,
                attachments: [email(8001, "Your e-ticket receipt")],
                flightInfo: { airline: { name: "Example Air", iata: "EX" }, number: 1 },
                depart: { date: "2026-11-21", time: "08:00", airport: { iata: "AAA" } },
                arrive: { date: "2026-11-21", time: "10:00", airport: { iata: "BBB" } },
              },
              {
                id: 61,
                type: "flight",
                emailId: 8002,
                attachments: [email(8003, "Someone else's")],
                flightInfo: { number: 2 },
                depart: { date: "2026-11-23", time: "08:00" },
                arrive: { date: "2026-11-23", time: "10:00" },
              },
            ],
          },
        ],
      },
    },
  };
  const { bundle } = normaliseCompleteWanderlog(bookings, { sourceText: JSON.stringify(bookings) });
  const items = bundle.days.flatMap((day) => day.items);

  it("carries cancellation terms, guests and the email subject on both edges of a stay", () => {
    const stay = items.filter((item) => item.type === "lodging" && item.name === "Example Hotel");
    expect(stay).toHaveLength(2);
    for (const item of stay) {
      expect(item).toMatchObject({
        cancellationDeadline: "2026-11-18 23:59",
        cancellationPolicy: "Free cancellation until the deadline.",
        guests: { adultCount: 2, roomCount: 1 },
        bookingEmailSubject: "Your booking is confirmed",
      });
      expect(item).not.toHaveProperty("guests.childrenAges");
    }
  });

  it("leaves a stay without them alone", () => {
    const plain = items.find((item) => item.type === "lodging" && item.name === "Plain Inn");
    expect(plain).toBeDefined();
    for (const key of ["cancellationDeadline", "cancellationPolicy", "guests", "bookingEmailSubject"]) {
      expect(plain).not.toHaveProperty(key);
    }
  });

  it("gives a flight the subject of its own email only", () => {
    const flights = items.filter((item) => item.type === "flight");
    expect(flights.find((item) => item.flightNumber === "1")).toMatchObject({ bookingEmailSubject: "Your e-ticket receipt" });
    expect(flights.find((item) => item.flightNumber === "2")).not.toHaveProperty("bookingEmailSubject");
  });

  it("never carries email ids, attachments or account ids", () => {
    const text = JSON.stringify(bundle);
    for (const leaked of ["7001", "7002", "8001", "Other mail", "attachments", "emailId", "addedBy", "999", "rating\":\"positive"]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("place locality", () => {
  const component = (long_name: string, ...types: string[]) => ({ long_name, types: [...types, "political"] });

  it("uses Google's locality, adding the region when the locality is a ward inside it", () => {
    expect(localityFrom([component("Kanazawa", "locality"), component("Japan", "country")])).toBe("Kanazawa");
    expect(localityFrom([component("Shinjuku City", "locality"), component("Tokyo", "administrative_area_level_1")]))
      .toBe("Shinjuku City, Tokyo");
    expect(localityFrom([component("Osaka", "locality"), component("Osaka", "administrative_area_level_1")])).toBe("Osaka");
    expect(localityFrom(undefined)).toBeUndefined();
    expect(localityFrom([component("Japan", "country")])).toBeUndefined();
  });
});
