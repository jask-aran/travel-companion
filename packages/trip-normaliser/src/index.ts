import { createHash } from "node:crypto";
import { parseTripBundle, type DayItem, type Place, type RouteLeg, type TripBundle, type TripDay } from "../../trip-schema/src/index.js";

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

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is JsonRecord => Boolean(item)) : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceId(prefix: string, value: unknown): string {
  return `${prefix}:${String(value)}`;
}

function quillText(value: unknown): string | undefined {
  const valueRecord = record(value);
  const ops = records(valueRecord?.ops);
  const text = ops.map((op) => string(op.insert) ?? "").join("").trim();
  return text || undefined;
}

function normaliseTravelMode(value: unknown): RouteLeg["travelMode"] {
  switch (string(value)?.toLowerCase()) {
    case "walk":
    case "walking": return "walking";
    case "drive":
    case "driving": return "driving";
    case "cycle":
    case "bicycling":
    case "cycling": return "cycling";
    case "ferry": return "ferry";
    case "flight":
    case "flying": return "flight";
    default: return "transit";
  }
}

function selectPlaceOverride(overrides: ImportOverrides | undefined, blockId: number | undefined, googlePlaceId: string | undefined): PlaceOverride | undefined {
  return (blockId !== undefined ? overrides?.places?.[sourceId("source-block", blockId)] : undefined)
    ?? (googlePlaceId ? overrides?.places?.[sourceId("google-place", googlePlaceId)] : undefined);
}

function placeFromBlock(block: JsonRecord, overrides: ImportOverrides | undefined, warnings: ImportWarning[]): Place | undefined {
  const rawPlace = record(block.place) ?? record(record(block.hotel)?.googlePlace) ?? record(block.hotel);
  if (!rawPlace) return undefined;

  const blockId = number(block.id);
  const googlePlaceId = string(rawPlace.place_id) ?? string(rawPlace.placeId);
  const id = googlePlaceId ? sourceId("google-place", googlePlaceId) : sourceId("source-block", blockId ?? "unknown");
  const geometry = record(rawPlace.geometry);
  const location = record(geometry?.location);
  const override = selectPlaceOverride(overrides, blockId, googlePlaceId);
  const imageKeys = Array.isArray(block.imageKeys) ? block.imageKeys : [];
  const photoUrls = Array.isArray(rawPlace.photo_urls) ? rawPlace.photo_urls : [];
  const firstResolvedPhoto = string(photoUrls[0]);
  const firstImageKey = string(imageKeys[0]);

  const place: Place = {
    id,
    ...(blockId !== undefined ? { sourceBlockId: blockId } : {}),
    ...(googlePlaceId ? { googlePlaceId } : {}),
    name: override?.displayName ?? string(rawPlace.name) ?? "Unnamed place",
    ...(string(rawPlace.types)?.length ? { category: string(rawPlace.types) } : {}),
    ...((override?.publishAddress ?? true) && (override?.address ?? string(rawPlace.formatted_address))
      ? { address: override?.address ?? string(rawPlace.formatted_address) }
      : {}),
    ...(override?.latitude ?? number(location?.lat) ?? number(rawPlace.latitude) !== undefined
      ? { latitude: override?.latitude ?? number(location?.lat) ?? number(rawPlace.latitude) }
      : {}),
    ...(override?.longitude ?? number(location?.lng) ?? number(rawPlace.longitude) !== undefined
      ? { longitude: override?.longitude ?? number(location?.lng) ?? number(rawPlace.longitude) }
      : {}),
    ...(number(rawPlace.rating) !== undefined ? { rating: number(rawPlace.rating) } : {}),
    ...(number(rawPlace.user_ratings_total) !== undefined ? { ratingCount: number(rawPlace.user_ratings_total) } : {}),
    ...(override?.imageUrl
      ? { image: { source: "manual" as const, url: override.imageUrl } }
      : firstResolvedPhoto
        ? { image: { source: "wanderlog" as const, url: firstResolvedPhoto } }
        : firstImageKey
          ? { image: { source: "wanderlog" as const, sourceKey: firstImageKey } }
          : {}),
  };

  if (place.latitude === undefined || place.longitude === undefined) {
    warnings.push({ code: "place-missing-coordinates", message: `${place.name} has no usable coordinates`, sourceId: id });
  }
  if (!place.image) warnings.push({ code: "place-missing-image", message: `${place.name} has no representative image`, sourceId: id });
  return place;
}

function itemOverride(overrides: ImportOverrides | undefined, blockId: number | undefined): ItemOverride | undefined {
  return blockId !== undefined ? overrides?.items?.[sourceId("source-block", blockId)] : undefined;
}

function itemFromBlock(block: JsonRecord, places: Record<string, Place>, overrides: ImportOverrides | undefined, warnings: ImportWarning[]): DayItem | undefined {
  const blockId = number(block.id);
  const id = sourceId("source-block", blockId ?? `anonymous-${Object.keys(places).length}`);
  const override = itemOverride(overrides, blockId);
  const common = {
    id,
    ...(blockId !== undefined ? { sourceBlockId: blockId } : {}),
    ...(override?.startTime ?? string(block.startTime) ? { startTime: override?.startTime ?? string(block.startTime) } : {}),
    ...(override?.endTime ?? string(block.endTime) ? { endTime: override?.endTime ?? string(block.endTime) } : {}),
    ...(override?.notes ?? quillText(block.text) ? { notes: override?.notes ?? quillText(block.text) } : {}),
    ...(override?.status ? { status: override.status } : {}),
  };

  switch (string(block.type)) {
    case "place": {
      const place = placeFromBlock(block, overrides, warnings);
      if (!place) return undefined;
      places[place.id] ??= place;
      const isLodging = Boolean(block.hotel) || records(record(block.place)?.types).some(() => false);
      return isLodging
        ? { ...common, type: "lodging", placeId: place.id, name: place.name }
        : { ...common, type: "place", placeId: place.id };
    }
    case "note": {
      const text = override?.notes ?? quillText(block.text);
      return text ? { ...common, type: "note", text } : undefined;
    }
    case "flight": {
      const info = record(block.flightInfo);
      const depart = record(block.depart);
      const arrive = record(block.arrive);
      const departAirport = record(depart?.airport);
      const arriveAirport = record(arrive?.airport);
      return {
        ...common,
        type: "flight",
        ...(string(record(info?.airline)?.name) ? { airline: string(record(info?.airline)?.name) } : {}),
        ...(info?.number !== undefined ? { flightNumber: String(info.number) } : {}),
        ...(string(departAirport?.iata) ? { departAirport: string(departAirport?.iata) } : {}),
        ...(string(arriveAirport?.iata) ? { arriveAirport: string(arriveAirport?.iata) } : {}),
      };
    }
    default:
      warnings.push({ code: "unsupported-block", message: `Skipped unsupported block type ${String(block.type)}`, sourceId: id });
      return undefined;
  }
}

function getTripPlan(source: JsonRecord): JsonRecord {
  const direct = record(source.tripPlan);
  if (direct) return direct;
  const nested = record(record(source.data)?.tripPlan);
  if (nested) return nested;
  throw new Error("Source does not contain a tripPlan object");
}

function getResources(source: JsonRecord): JsonRecord {
  return record(source.resources) ?? record(record(source.data)?.resources) ?? {};
}

function addGlobalFlights(daysByDate: Map<string, TripDay>, tripPlan: JsonRecord, places: Record<string, Place>, overrides: ImportOverrides | undefined, warnings: ImportWarning[]): void {
  const itinerary = record(tripPlan.itinerary);
  for (const section of records(itinerary?.sections)) {
    if (string(section.type) !== "flights") continue;
    for (const block of records(section.blocks)) {
      const date = string(record(block.depart)?.date);
      const day = date ? daysByDate.get(date) : undefined;
      const item = itemFromBlock(block, places, overrides, warnings);
      if (day && item && !day.items.some((candidate) => candidate.id === item.id)) day.items.unshift(item);
    }
  }
}

function routeLegsFromResources(resources: JsonRecord, places: Record<string, Place>, warnings: ImportWarning[]): Record<string, RouteLeg> {
  const rawRoutes = record(resources.distancesBetweenPlaces) ?? {};
  const placeIdLookup = new Map(Object.values(places).flatMap((place) => place.googlePlaceId ? [[place.googlePlaceId, place.id] as const] : []));
  const routeLegs: Record<string, RouteLeg> = {};

  for (const [key, value] of Object.entries(rawRoutes)) {
    const raw = record(value);
    const route = record(raw?.route);
    const fromGoogleId = string(raw?.fromPlaceId);
    const toGoogleId = string(raw?.toPlaceId);
    const fromPlaceId = fromGoogleId ? placeIdLookup.get(fromGoogleId) : undefined;
    const toPlaceId = toGoogleId ? placeIdLookup.get(toGoogleId) : undefined;
    if (!fromPlaceId || !toPlaceId) continue;

    const id = `route:${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
    routeLegs[id] = {
      id,
      fromPlaceId,
      toPlaceId,
      travelMode: normaliseTravelMode(raw?.travelMode),
      ...(number(record(route?.distance)?.value) !== undefined ? { distanceMetres: number(record(route?.distance)?.value) } : {}),
      ...(number(record(route?.duration)?.value) !== undefined ? { durationSeconds: number(record(route?.duration)?.value) } : {}),
      ...(string(route?.polyline) ? { encodedPolyline: string(route?.polyline) } : {}),
    };
  }

  if (Object.keys(routeLegs).length === 0) warnings.push({ code: "no-route-legs", message: "No cached route legs matched imported places" });
  return routeLegs;
}

export function normaliseWanderlog(source: JsonRecord, options: NormaliseOptions): { bundle: TripBundle; report: ImportReport } {
  const warnings: ImportWarning[] = [];
  const tripPlan = getTripPlan(source);
  const resources = getResources(source);
  const itinerary = record(tripPlan.itinerary);
  const sections = records(itinerary?.sections);
  const places: Record<string, Place> = {};
  const daysByDate = new Map<string, TripDay>();

  for (const section of sections) {
    const date = string(section.date);
    if (!date) continue;
    const items = records(section.blocks)
      .map((block) => itemFromBlock(block, places, options.overrides, warnings))
      .filter((item): item is DayItem => Boolean(item));
    const orderedPlaceIds = items.flatMap((item) => item.type === "place" || item.type === "lodging" ? (item.placeId ? [item.placeId] : []) : []);
    daysByDate.set(date, {
      id: `day:${date}`,
      date,
      title: string(section.heading) ?? string(section.displayHeading) ?? date,
      timezone: "Asia/Tokyo",
      items,
      map: { orderedPlaceIds, routeLegIds: [] },
    });
  }

  addGlobalFlights(daysByDate, tripPlan, places, options.overrides, warnings);
  const routeLegs = routeLegsFromResources(resources, places, warnings);

  for (const day of daysByDate.values()) {
    const ordered = day.map.orderedPlaceIds;
    day.map.routeLegIds = Object.values(routeLegs)
      .filter((leg) => ordered.includes(leg.fromPlaceId) && ordered.includes(leg.toPlaceId))
      .map((leg) => leg.id);
  }

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const tripId = string(tripPlan.key) ?? sourceId("trip", tripPlan.id ?? "unknown");
  const revision = createHash("sha256").update(options.sourceText).digest("hex").slice(0, 16);
  const bundle = parseTripBundle({
    schemaVersion: 1,
    tripId,
    revision,
    generatedAt,
    trip: {
      title: string(tripPlan.title) ?? "Untitled trip",
      startDate: string(tripPlan.startDate),
      endDate: string(tripPlan.endDate),
    },
    days: [...daysByDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    places,
    routeLegs,
  });

  const report: ImportReport = {
    sourceKind: options.sourceKind,
    sourceFingerprint: createHash("sha256").update(options.sourceText).digest("hex"),
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
  };

  return { bundle, report };
}
