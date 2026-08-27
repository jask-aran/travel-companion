import { parseTripBundle, type Place } from "@travel-companion/trip-schema";
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
    const checkOut = string(hotel?.checkOut);
    const checkInDay = checkIn
      ? bundle.days.find((candidate) => candidate.date === checkIn)
      : undefined;
    const checkOutDay =
      checkOut && checkOut !== checkIn
        ? bundle.days.find((candidate) => candidate.date === checkOut)
        : undefined;
    const rawPlace = record(block.place);
    if (!rawPlace || sourceBlockId === undefined) continue;
    if (!checkInDay && !checkOutDay) continue;

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

    const itemOverride = overrides?.items?.[`source-block:${sourceBlockId}`];
    // Wanderlog stores no check-in/out *times*, only these dates — but it does
    // carry the booking details you actually need at the desk.
    const placeRecord = record(block.place);
    const confirmationNumber =
      string(hotel?.confirmationNumber) || string(block.confirmationNumber);
    const phone = string(placeRecord?.international_phone_number);
    const website = string(placeRecord?.website);
    const travellerNames = Array.isArray(hotel?.travelerNames)
      ? hotel.travelerNames.filter((name): name is string => typeof name === "string")
      : undefined;

    const lodgingFields = {
      sourceBlockId,
      type: "lodging" as const,
      placeId,
      name: place.name,
      ...(checkIn ? { checkInDate: checkIn } : {}),
      ...(checkOut ? { checkOutDate: checkOut } : {}),
      ...(confirmationNumber ? { confirmationNumber } : {}),
      ...(phone ? { phone } : {}),
      ...(website ? { website } : {}),
      ...(travellerNames?.length ? { travellerNames } : {}),
      ...(itemOverride?.startTime ? { startTime: itemOverride.startTime } : {}),
      ...(itemOverride?.endTime ? { endTime: itemOverride.endTime } : {}),
      ...(itemOverride?.notes ? { notes: itemOverride.notes } : {}),
      ...(itemOverride?.status ? { status: itemOverride.status } : {}),
    };

    if (checkInDay) {
      const itemId = `source-block:${sourceBlockId}`;
      if (!checkInDay.items.some((item) => item.id === itemId)) {
        checkInDay.items.unshift({
          id: itemId,
          ...lodgingFields,
          phase: "check-in",
        });
      }
      if (!checkInDay.map.orderedPlaceIds.includes(placeId)) {
        checkInDay.map.orderedPlaceIds.unshift(placeId);
      }
    }

    // Separate check-out callout on the departure day (Wanderlog-style edge markers).
    if (checkOutDay) {
      const checkoutId = `source-block:${sourceBlockId}:checkout`;
      if (!checkOutDay.items.some((item) => item.id === checkoutId)) {
        checkOutDay.items.push({
          id: checkoutId,
          ...lodgingFields,
          phase: "check-out",
        });
      }
      if (!checkOutDay.map.orderedPlaceIds.includes(placeId)) {
        checkOutDay.map.orderedPlaceIds.push(placeId);
      }
    }
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
