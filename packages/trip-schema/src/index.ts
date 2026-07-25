import * as v from "valibot";

const isoDate = v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/));
const optionalString = v.optional(v.string());
const optionalNumber = v.optional(v.number());

export const PlaceImageSchema = v.object({
  source: v.picklist(["wanderlog", "google-places", "manual", "fallback"]),
  url: optionalString,
  sourceKey: optionalString,
  width: optionalNumber,
  height: optionalNumber,
  attribution: v.optional(
    v.object({
      label: optionalString,
      uri: optionalString,
    }),
  ),
  sourcePageUri: optionalString,
});

export const PlaceSchema = v.object({
  id: v.string(),
  sourceBlockId: v.optional(v.number()),
  googlePlaceId: optionalString,
  name: v.string(),
  category: optionalString,
  address: optionalString,
  latitude: optionalNumber,
  longitude: optionalNumber,
  rating: optionalNumber,
  ratingCount: optionalNumber,
  image: v.optional(PlaceImageSchema),
});

const BaseItemSchema = v.object({
  id: v.string(),
  sourceBlockId: v.optional(v.number()),
  startTime: optionalString,
  endTime: optionalString,
  notes: v.optional(v.string()),
  status: v.optional(v.picklist(["confirmed", "tentative", "optional"])),
});

export const PlaceItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("place"),
  placeId: v.string(),
});

export const NoteItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("note"),
  text: v.string(),
});

export const TransitItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("transit"),
  routeLegId: v.optional(v.string()),
  label: v.optional(v.string()),
});

export const FlightItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("flight"),
  airline: optionalString,
  flightNumber: optionalString,
  departAirport: optionalString,
  arriveAirport: optionalString,
});

export const LodgingItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("lodging"),
  placeId: v.optional(v.string()),
  name: v.string(),
});

export const DayItemSchema = v.variant("type", [
  PlaceItemSchema,
  NoteItemSchema,
  TransitItemSchema,
  FlightItemSchema,
  LodgingItemSchema,
]);

export const RouteLegSchema = v.object({
  id: v.string(),
  fromPlaceId: v.string(),
  toPlaceId: v.string(),
  travelMode: v.picklist(["walking", "transit", "driving", "cycling", "ferry", "flight"]),
  distanceMetres: optionalNumber,
  durationSeconds: optionalNumber,
  encodedPolyline: optionalString,
});

export const TripDaySchema = v.object({
  id: v.string(),
  date: isoDate,
  title: v.string(),
  subtitle: optionalString,
  timezone: v.string(),
  items: v.array(DayItemSchema),
  map: v.object({
    orderedPlaceIds: v.array(v.string()),
    routeLegIds: v.array(v.string()),
  }),
});

export const TripBundleSchema = v.object({
  schemaVersion: v.literal(1),
  tripId: v.string(),
  revision: v.string(),
  generatedAt: v.string(),
  trip: v.object({
    title: v.string(),
    startDate: isoDate,
    endDate: isoDate,
  }),
  days: v.array(TripDaySchema),
  places: v.record(v.string(), PlaceSchema),
  routeLegs: v.record(v.string(), RouteLegSchema),
});

export type PlaceImage = v.InferOutput<typeof PlaceImageSchema>;
export type Place = v.InferOutput<typeof PlaceSchema>;
export type DayItem = v.InferOutput<typeof DayItemSchema>;
export type RouteLeg = v.InferOutput<typeof RouteLegSchema>;
export type TripDay = v.InferOutput<typeof TripDaySchema>;
export type TripBundle = v.InferOutput<typeof TripBundleSchema>;

export function parseTripBundle(input: unknown): TripBundle {
  return v.parse(TripBundleSchema, input);
}
