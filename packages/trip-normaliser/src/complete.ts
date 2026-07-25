import { parseTripBundle, type Place } from "../../trip-schema/src/index.js";
import {
  normaliseWanderlog,
  type ImportOverrides,
  type ImportReport,
} from "./index.js";

type JsonRecord = Record<string, unknown>;

interface Options {
  sourceKind: "cli-json" | "html-mobx";
  sourceText: string;
  overrides?: ImportOverrides;
  generatedAt?: string;
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== undefined)
    : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tripPlanFrom(source: JsonRecord): JsonRecord | undefined {
  return record(source.tripPlan) ?? record(record(source.data)?.tripPlan);
}

function addGlobalLodging(
  source: JsonRecord,
  bundle: ReturnType<typeof normaliseWanderlog>["bundle"],
  report: ImportReport,
  overrides?: ImportOverrides,
): void {
  const tripPlan = tripPlanFrom(source);
  const sections = records(record(tripPlan?.itinerary)?.sections);
  const lodgingSection = sections.find((section) => string(section.type) === "hotels");
  if (!lodgingSection) return;

  for (const block of records(lodgingSection.blocks)) {
    const sourceBlockId = number(block.id);
    const hotel = record(block.hotel);
    const checkIn = string(hotel?.checkIn);
    const day = checkIn ? bundle.days.find((candidate) => candidate.date === checkIn) : undefined;
    const rawPlace = record(block.place);
    if (!day || !rawPlace || sourceBlockId === undefined) continue;

    const googlePlaceId = string(rawPlace.place_id);
    const placeId = googlePlaceId
      ? `google-place:${googlePlaceId}`
      : `source-block:${sourceBlockId}`;
    const placeOverride = overrides?.places?.[`source-block:${sourceBlockId}`]
      ?? (googlePlaceId ? overrides?.places?.[`google-place:${googlePlaceId}`] : undefined);
    const location = record(record(rawPlace.geometry)?.location);
    const latitude = placeOverride?.latitude ?? number(location?.lat);
    const longitude = placeOverride?.longitude ?? number(location?.lng);
    const address = placeOverride?.address ?? string(rawPlace.formatted_address);
    const photoUrl = Array.isArray(rawPlace.photo_urls) ? string(rawPlace.photo_urls[0]) : undefined;
    const imageKey = Array.isArray(block.imageKeys) ? string(block.imageKeys[0]) : undefined;

    const place: Place = bundle.places[placeId] ?? {
      id: placeId,
      sourceBlockId,
      name: placeOverride?.displayName ?? string(rawPlace.name) ?? "Accommodation",
    };
    if (googlePlaceId) place.googlePlaceId = googlePlaceId;
    if ((placeOverride?.publishAddress ?? true) && address) place.address = address;
    if (latitude !== undefined) place.latitude = latitude;
    if (longitude !== undefined) place.longitude = longitude;
    if (placeOverride?.imageUrl) place.image = { source: "manual", url: placeOverride.imageUrl };
    else if (photoUrl) place.image = { source: "wanderlog", url: photoUrl };
    else if (imageKey) place.image = { source: "wanderlog", sourceKey: imageKey };
    bundle.places[placeId] = place;

    const itemId = `source-block:${sourceBlockId}`;
    if (!day.items.some((item) => item.id === itemId)) {
      const itemOverride = overrides?.items?.[itemId];
      day.items.unshift({
        id: itemId,
        sourceBlockId,
        type: "lodging",
        placeId,
        name: place.name,
        ...(itemOverride?.startTime ? { startTime: itemOverride.startTime } : {}),
        ...(itemOverride?.endTime ? { endTime: itemOverride.endTime } : {}),
        ...(itemOverride?.notes ? { notes: itemOverride.notes } : {}),
        ...(itemOverride?.status ? { status: itemOverride.status } : {}),
      });
    }
    if (!day.map.orderedPlaceIds.includes(placeId)) day.map.orderedPlaceIds.unshift(placeId);
  }

  report.counts.items = bundle.days.reduce((sum, day) => sum + day.items.length, 0);
  report.counts.places = Object.keys(bundle.places).length;
  report.counts.images = Object.values(bundle.places).filter((place) => place.image).length;
}

export function normaliseCompleteWanderlog(
  source: JsonRecord,
  options: Options,
): ReturnType<typeof normaliseWanderlog> {
  const result = normaliseWanderlog(source, options);
  addGlobalLodging(source, result.bundle, result.report, options.overrides);
  result.bundle = parseTripBundle(result.bundle);
  return result;
}
