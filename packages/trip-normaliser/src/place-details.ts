import type { PlaceDetails, TripBundle } from "../../trip-schema/src/index.js";

/**
 * Wanderlog scrapes a rich POI record for every place and parks it in
 * `resources.placeMetadata`, keyed by Google place id — separate from the
 * itinerary blocks, which is why none of it reached the app before.
 */

type Json = Record<string, unknown>;

const asRecord = (value: unknown): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Google returns "1430"; a clock face reads better as "14:30". */
function clockTime(raw: unknown): string | undefined {
  const value = asString(raw);
  if (!value || !/^\d{3,4}$/.test(value)) return undefined;
  const padded = value.padStart(4, "0");
  return `${padded.slice(0, 2)}:${padded.slice(2)}`;
}

function openingPeriods(raw: unknown): PlaceDetails["openingPeriods"] {
  if (!Array.isArray(raw)) return undefined;
  const periods = raw.flatMap((entry) => {
    const record = asRecord(entry);
    const open = asRecord(record?.open);
    const day = asNumber(open?.day);
    const openAt = clockTime(open?.time);
    if (day === undefined || !openAt) return [];
    const closeAt = clockTime(asRecord(record?.close)?.time);
    return [{ day, open: openAt, ...(closeAt ? { close: closeAt } : {}) }];
  });
  return periods.length ? periods : undefined;
}

export function attachPlaceDetails(bundle: TripBundle, source: unknown): number {
  // `placeMetadata` is an array in CLI output; tolerate a keyed object too.
  const metadata = asRecord(asRecord(source)?.resources)?.placeMetadata;
  const entries = Array.isArray(metadata)
    ? metadata
    : metadata
      ? Object.values(asRecord(metadata) ?? {})
      : undefined;
  if (!entries?.length) return 0;

  // Index by Google place id — the metadata's own ids are Wanderlog-internal.
  const byPlaceId = new Map<string, Json>();
  for (const entry of entries) {
    const record = asRecord(entry);
    const placeId = asString(record?.placeId);
    if (record && placeId) byPlaceId.set(placeId, record);
  }

  let attached = 0;
  for (const place of Object.values(bundle.places)) {
    const meta = place.googlePlaceId ? byPlaceId.get(place.googlePlaceId) : undefined;
    if (!meta) continue;

    const categories = Array.isArray(meta.categories)
      ? meta.categories.filter((entry): entry is string => typeof entry === "string")
      : undefined;

    const details: PlaceDetails = {
      ...(categories?.length ? { categories } : {}),
      ...(asString(meta.description) ? { summary: asString(meta.description) } : {}),
      ...(asString(meta.generatedDescription)
        ? { description: asString(meta.generatedDescription) }
        : {}),
      ...(openingPeriods(meta.openingPeriods)
        ? { openingPeriods: openingPeriods(meta.openingPeriods) }
        : {}),
      ...(asNumber(meta.minMinutesSpent) !== undefined
        ? { visitMinutesMin: asNumber(meta.minMinutesSpent) }
        : {}),
      ...(asNumber(meta.maxMinutesSpent) !== undefined
        ? { visitMinutesMax: asNumber(meta.maxMinutesSpent) }
        : {}),
      ...(asString(meta.website) ? { website: asString(meta.website) } : {}),
      ...(asString(meta.internationalPhoneNumber)
        ? { phone: asString(meta.internationalPhoneNumber) }
        : {}),
      ...(asString(meta.businessStatus) ? { businessStatus: asString(meta.businessStatus) } : {}),
      ...(meta.permanentlyClosed === true ? { permanentlyClosed: true } : {}),
    };

    if (Object.keys(details).length > 0) {
      place.details = details;
      attached += 1;
    }
  }

  return attached;
}
