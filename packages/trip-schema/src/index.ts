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

/**
 * A Google Places (New) photo reference.
 *
 * Google's terms forbid caching or re-hosting the image (ToS 3.2.3(b)), and
 * the `name` itself expires — so this is refreshed on every ingest and the
 * image is loaded live from Google at render time. Photos are therefore
 * unavailable offline, which is a deliberate, accepted trade.
 */
export const PlacePhotoSchema = v.object({
  /** `places/PLACE_ID/photos/PHOTO_RESOURCE` */
  name: v.string(),
  widthPx: optionalNumber,
  heightPx: optionalNumber,
  /** Required by Google wherever the image is displayed. */
  attributions: v.optional(
    v.array(v.object({ displayName: v.string(), uri: optionalString })),
  ),
});

/** A single opening window. `day` is 0 = Sunday, matching Google. */
export const OpeningPeriodSchema = v.object({
  day: v.number(),
  open: v.string(),
  close: optionalString,
});

/**
 * POI detail Wanderlog scrapes alongside the itinerary and stores in its own
 * `resources.placeMetadata` block, keyed by Google place id. Richer than the
 * per-item data: full category list, an editorial blurb, opening hours and a
 * typical visit length.
 */
export const PlaceDetailsSchema = v.object({
  categories: v.optional(v.array(v.string())),
  /** One-line Google editorial summary. */
  summary: optionalString,
  /** Longer Wanderlog-generated blurb. */
  description: optionalString,
  openingPeriods: v.optional(v.array(OpeningPeriodSchema)),
  /** Wanderlog's own estimate; user-contributed and occasionally implausible. */
  visitMinutesMin: optionalNumber,
  visitMinutesMax: optionalNumber,
  website: optionalString,
  phone: optionalString,
  /** e.g. OPERATIONAL, CLOSED_TEMPORARILY. */
  businessStatus: optionalString,
  permanentlyClosed: v.optional(v.boolean()),
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
  photo: v.optional(PlacePhotoSchema),
  details: v.optional(PlaceDetailsSchema),
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
  /** City names read far better than IATA codes on a card. */
  departCity: optionalString,
  arriveCity: optionalString,
  /** Local clock times at each end, HH:MM. */
  departTime: optionalString,
  arriveTime: optionalString,
  /** ISO dates; the arrival date differs from departure on overnight hops. */
  departDate: optionalString,
  arriveDate: optionalString,
  confirmationNumber: optionalString,
  travellerNames: v.optional(v.array(v.string())),
  /**
   * Place ids of the two airports. Wanderlog stores a flight outside the day's
   * sequence, but people add the airports as ordinary stops so its UI will draw
   * the travel to them — so these ids are what put the flight back in place.
   */
  departPlaceId: optionalString,
  arrivePlaceId: optionalString,
});

export const LodgingItemSchema = v.object({
  ...BaseItemSchema.entries,
  type: v.literal("lodging"),
  placeId: v.optional(v.string()),
  name: v.string(),
  /** ISO date YYYY-MM-DD when the stay begins. */
  checkInDate: optionalString,
  /** ISO date YYYY-MM-DD when the stay ends. */
  checkOutDate: optionalString,
  /** Which edge of the stay this card represents on a given day. */
  phase: v.optional(v.picklist(["check-in", "check-out", "stay"])),
  /** Wanderlog carries no check-in/out *times* — only these dates. */
  confirmationNumber: optionalString,
  phone: optionalString,
  website: optionalString,
  travellerNames: v.optional(v.array(v.string())),
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
export type OpeningPeriod = v.InferOutput<typeof OpeningPeriodSchema>;
export type PlaceDetails = v.InferOutput<typeof PlaceDetailsSchema>;
export type PlacePhoto = v.InferOutput<typeof PlacePhotoSchema>;
export type Place = v.InferOutput<typeof PlaceSchema>;
export type PlaceItem = v.InferOutput<typeof PlaceItemSchema>;
export type NoteItem = v.InferOutput<typeof NoteItemSchema>;
export type TransitItem = v.InferOutput<typeof TransitItemSchema>;
export type FlightItem = v.InferOutput<typeof FlightItemSchema>;
export type LodgingItem = v.InferOutput<typeof LodgingItemSchema>;
export type DayItem = v.InferOutput<typeof DayItemSchema>;
export type RouteLeg = v.InferOutput<typeof RouteLegSchema>;
export type TripDay = v.InferOutput<typeof TripDaySchema>;
export type TripBundle = v.InferOutput<typeof TripBundleSchema>;

export function parseTripBundle(input: unknown): TripBundle {
  return v.parse(TripBundleSchema, input);
}
