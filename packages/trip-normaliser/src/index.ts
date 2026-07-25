import { createHash } from "node:crypto";
import {
  parseTripBundle,
  type DayItem,
  type Place,
  type RouteLeg,
  type TripBundle,
  type TripDay,
} from "../../trip-schema/src/index.js";

export interface ImportWarning {
  code: string;
  message: string;
  sourceId?: string;
}

export interface ImportReport {
  sourceKind: "cli-json" | "html-mobx";
  sourceFingerprint: string;
  counts: {
    days: number;
    items: number;
    places: number;
    routeLegs: number;
    images: number;
  };
  redacted: string[];
  warnings: ImportWarning[];
}

export interface PlaceOverride {
  displayName?: string;
  publishAddress?: boolean;
  address?: string;
  latitude?: number;
  longitude?: number;
  imageUrl?: string;
}

export interface ItemOverride {
  startTime?: string;
  endTime?: string;
  status?: "confirmed" | "tentative" | "optional";
  notes?: string;
}

export interface ImportOverrides {
  places?: Record<string, PlaceOverride>;
  items?: Record<string, ItemOverride>;
}

interface NormaliseOptions {
  sourceKind: "cli-json" | "html-mobx";
  sourceText: string;
  overrides?: ImportOverrides;
  generatedAt?: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceId(prefix: string, value: unknown): string {
  return `${prefix}:${String(value)}`;
}

function quillText(value: unknown): string | undefined {
  const ops = asRecords(asRecord(value)?.ops);
  const text = ops.map((op) => asString(op.insert) ?? "").join("").trim();
  return text || undefined;
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) ? asString(value[0]) : undefined;
}

function firstType(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(asString).find(Boolean) : undefined;
}

function travelMode(value: unknown): RouteLeg["travelMode"] {
  switch (asString(value)?.toLowerCase()) {
    case "walk":
    case "walking":
      return "walking";
    case "drive":
    case "driving":
      return "driving";
    case "cycle":
    case "cycling":
    case "bicycling":
      return "cycling";
    case "ferry":
      return "ferry";
    case "flight":
    case "flying":
      return "flight";
    default:
      return "transit";
  }
}

function tripPlanFrom(source: JsonRecord): JsonRecord {
  const direct = asRecord(source.tripPlan);
  if (direct) return direct;
  const nested = asRecord(asRecord(source.data)?.tripPlan);
  if (nested) return nested;
  throw new Error("Source does not contain a tripPlan object");
}

function resourcesFrom(source: JsonRecord): JsonRecord {
  return asRecord(source.resources) ?? asRecord(asRecord(source.data)?.resources) ?? {};
}

function placeOverride(
  overrides: ImportOverrides | undefined,
  blockId: number | undefined,
  googlePlaceId: string | undefined,
): PlaceOverride | undefined {
  if (blockId !== undefined) {
    const byBlock = overrides?.places?.[sourceId("source-block", blockId)];
    if (byBlock) return byBlock;
  }
  return googlePlaceId ? overrides?.places?.[sourceId("google-place", googlePlaceId)] : undefined;
}

function itemOverride(overrides: ImportOverrides | undefined, blockId: number | undefined): ItemOverride | undefined {
  return blockId === undefined ? undefined : overrides?.items?.[sourceId("source-block", blockId)];
}

function placeFromBlock(
  block: JsonRecord,
  overrides: ImportOverrides | undefined,
  warnings: ImportWarning[],
): Place | undefined {
  const rawPlace = asRecord(block.place) ?? asRecord(asRecord(block.hotel)?.googlePlace) ?? asRecord(block.hotel);
  if (!rawPlace) return undefined;

  const blockId = asNumber(block.id);
  const googlePlaceId = asString(rawPlace.place_id) ?? asString(rawPlace.placeId);
  const id = googlePlaceId
    ? sourceId("google-place", googlePlaceId)
    : sourceId("source-block", blockId ?? "unknown");
  const location = asRecord(asRecord(rawPlace.geometry)?.location);
  const override = placeOverride(overrides, blockId, googlePlaceId);
  const latitude = override?.latitude ?? asNumber(location?.lat) ?? asNumber(rawPlace.latitude);
  const longitude = override?.longitude ?? asNumber(location?.lng) ?? asNumber(rawPlace.longitude);
  const address = override?.address ?? asString(rawPlace.formatted_address);
  const resolvedPhoto = firstString(rawPlace.photo_urls);
  const imageKey = firstString(block.imageKeys);

  const place: Place = {
    id,
    name: override?.displayName ?? asString(rawPlace.name) ?? "Unnamed place",
  };

  if (blockId !== undefined) place.sourceBlockId = blockId;
  if (googlePlaceId) place.googlePlaceId = googlePlaceId;
  const category = firstType(rawPlace.types);
  if (category) place.category = category;
  if ((override?.publishAddress ?? true) && address) place.address = address;
  if (latitude !== undefined) place.latitude = latitude;
  if (longitude !== undefined) place.longitude = longitude;
  const rating = asNumber(rawPlace.rating);
  if (rating !== undefined) place.rating = rating;
  const ratingCount = asNumber(rawPlace.user_ratings_total);
  if (ratingCount !== undefined) place.ratingCount = ratingCount;

  if (override?.imageUrl) place.image = { source: "manual", url: override.imageUrl };
  else if (resolvedPhoto) place.image = { source: "wanderlog", url: resolvedPhoto };
  else if (imageKey) place.image = { source: "wanderlog", sourceKey: imageKey };

  if (latitude === undefined || longitude === undefined) {
    warnings.push({ code: "place-missing-coordinates", message: `${place.name} has no usable coordinates`, sourceId: id });
  }
  if (!place.image) {
    warnings.push({ code: "place-missing-image", message: `${place.name} has no representative image`, sourceId: id });
  }
  return place;
}

function commonItemFields(block: JsonRecord, overrides: ImportOverrides | undefined): {
  id: string;
  sourceBlockId?: number;
  startTime?: string;
  endTime?: string;
  notes?: string;
  status?: "confirmed" | "tentative" | "optional";
} {
  const blockId = asNumber(block.id);
  const override = itemOverride(overrides, blockId);
  const common: {
    id: string;
    sourceBlockId?: number;
    startTime?: string;
    endTime?: string;
    notes?: string;
    status?: "confirmed" | "tentative" | "optional";
  } = { id: sourceId("source-block", blockId ?? "unknown") };

  if (blockId !== undefined) common.sourceBlockId = blockId;
  const startTime = override?.startTime ?? asString(block.startTime);
  if (startTime) common.startTime = startTime;
  const endTime = override?.endTime ?? asString(block.endTime);
  if (endTime) common.endTime = endTime;
  const notes = override?.notes ?? quillText(block.text);
  if (notes) common.notes = notes;
  if (override?.status) common.status = override.status;
  return common;
}

function itemFromBlock(
  block: JsonRecord,
  places: Record<string, Place>,
  overrides: ImportOverrides | undefined,
  warnings: ImportWarning[],
): DayItem | undefined {
  const common = commonItemFields(block, overrides);

  switch (asString(block.type)) {
    case "place": {
      const place = placeFromBlock(block, overrides, warnings);
      if (!place) return undefined;
      places[place.id] ??= place;
      if (block.hotel) return { ...common, type: "lodging", placeId: place.id, name: place.name };
      return { ...common, type: "place", placeId: place.id };
    }
    case "note": {
      const text = common.notes;
      return text ? { ...common, type: "note", text } : undefined;
    }
    case "flight": {
      const info = asRecord(block.flightInfo);
      const airline = asString(asRecord(info?.airline)?.name);
      const flightNumber = info?.number === undefined ? undefined : String(info.number);
      const departAirport = asString(asRecord(asRecord(block.depart)?.airport)?.iata);
      const arriveAirport = asString(asRecord(asRecord(block.arrive)?.airport)?.iata);
      const item: DayItem = { ...common, type: "flight" };
      if (airline) item.airline = airline;
      if (flightNumber) item.flightNumber = flightNumber;
      if (departAirport) item.departAirport = departAirport;
      if (arriveAirport) item.arriveAirport = arriveAirport;
      return item;
    }
    default:
      warnings.push({
        code: "unsupported-block",
        message: `Skipped unsupported block type ${String(block.type)}`,
        sourceId: common.id,
      });
      return undefined;
  }
}

function addGlobalFlights(
  daysByDate: Map<string, TripDay>,
  tripPlan: JsonRecord,
  places: Record<string, Place>,
  overrides: ImportOverrides | undefined,
  warnings: ImportWarning[],
): void {
  const sections = asRecords(asRecord(tripPlan.itinerary)?.sections);
  for (const section of sections) {
    if (asString(section.type) !== "flights") continue;
    for (const block of asRecords(section.blocks)) {
      const date = asString(asRecord(block.depart)?.date);
      const day = date ? daysByDate.get(date) : undefined;
      const item = itemFromBlock(block, places, overrides, warnings);
      if (day && item && !day.items.some((candidate) => candidate.id === item.id)) day.items.unshift(item);
    }
  }
}

function routesFrom(
  resources: JsonRecord,
  places: Record<string, Place>,
  warnings: ImportWarning[],
): Record<string, RouteLeg> {
  const rawRoutes = asRecord(resources.distancesBetweenPlaces) ?? {};
  const byGooglePlace = new Map<string, string>();
  for (const place of Object.values(places)) {
    if (place.googlePlaceId) byGooglePlace.set(place.googlePlaceId, place.id);
  }

  const result: Record<string, RouteLeg> = {};
  for (const [key, value] of Object.entries(rawRoutes)) {
    const raw = asRecord(value);
    const route = asRecord(raw?.route);
    const fromGooglePlace = asString(raw?.fromPlaceId);
    const toGooglePlace = asString(raw?.toPlaceId);
    const fromPlaceId = fromGooglePlace ? byGooglePlace.get(fromGooglePlace) : undefined;
    const toPlaceId = toGooglePlace ? byGooglePlace.get(toGooglePlace) : undefined;
    if (!fromPlaceId || !toPlaceId) continue;

    const id = `route:${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
    const leg: RouteLeg = {
      id,
      fromPlaceId,
      toPlaceId,
      travelMode: travelMode(raw?.travelMode),
    };
    const distance = asNumber(asRecord(route?.distance)?.value);
    if (distance !== undefined) leg.distanceMetres = distance;
    const duration = asNumber(asRecord(route?.duration)?.value);
    if (duration !== undefined) leg.durationSeconds = duration;
    const polyline = asString(route?.polyline);
    if (polyline) leg.encodedPolyline = polyline;
    result[id] = leg;
  }

  if (Object.keys(result).length === 0) {
    warnings.push({ code: "no-route-legs", message: "No cached route legs matched imported places" });
  }
  return result;
}

export function normaliseWanderlog(
  source: JsonRecord,
  options: NormaliseOptions,
): { bundle: TripBundle; report: ImportReport } {
  const warnings: ImportWarning[] = [];
  const tripPlan = tripPlanFrom(source);
  const resources = resourcesFrom(source);
  const sections = asRecords(asRecord(tripPlan.itinerary)?.sections);
  const places: Record<string, Place> = {};
  const daysByDate = new Map<string, TripDay>();

  for (const section of sections) {
    const date = asString(section.date);
    if (!date) continue;
    const items = asRecords(section.blocks)
      .map((block) => itemFromBlock(block, places, options.overrides, warnings))
      .filter((item): item is DayItem => item !== undefined);
    const orderedPlaceIds = items.flatMap((item) => {
      if (item.type === "place") return [item.placeId];
      if (item.type === "lodging" && item.placeId) return [item.placeId];
      return [];
    });
    daysByDate.set(date, {
      id: `day:${date}`,
      date,
      title: asString(section.heading) ?? asString(section.displayHeading) ?? date,
      timezone: "Asia/Tokyo",
      items,
      map: { orderedPlaceIds, routeLegIds: [] },
    });
  }

  addGlobalFlights(daysByDate, tripPlan, places, options.overrides, warnings);
  const routeLegs = routesFrom(resources, places, warnings);
  for (const day of daysByDate.values()) {
    day.map.routeLegIds = Object.values(routeLegs)
      .filter((leg) => day.map.orderedPlaceIds.includes(leg.fromPlaceId) && day.map.orderedPlaceIds.includes(leg.toPlaceId))
      .map((leg) => leg.id);
  }

  const fingerprint = createHash("sha256").update(options.sourceText).digest("hex");
  const bundle = parseTripBundle({
    schemaVersion: 1,
    tripId: asString(tripPlan.key) ?? sourceId("trip", tripPlan.id ?? "unknown"),
    revision: fingerprint.slice(0, 16),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    trip: {
      title: asString(tripPlan.title) ?? "Untitled trip",
      startDate: asString(tripPlan.startDate),
      endDate: asString(tripPlan.endDate),
    },
    days: [...daysByDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    places,
    routeLegs,
  });

  return {
    bundle,
    report: {
      sourceKind: options.sourceKind,
      sourceFingerprint: fingerprint,
      counts: {
        days: bundle.days.length,
        items: bundle.days.reduce((sum, day) => sum + day.items.length, 0),
        places: Object.keys(bundle.places).length,
        routeLegs: Object.keys(bundle.routeLegs).length,
        images: Object.values(bundle.places).filter((place) => place.image).length,
      },
      redacted: [
        "account and contributor identifiers",
        "booking confirmation numbers and reservation attachments",
        "Google review bodies and full photo collections",
        "phone numbers, websites, address components, and browser state",
      ],
      warnings,
    },
  };
}
