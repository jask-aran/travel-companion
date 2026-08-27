import type { TripBundle } from "../../trip-schema/src/index.js";

/**
 * Attach Google Places (New) photo references to the bundle's places.
 *
 * Wanderlog's own exported image URLs are dead on arrival: they are expiring,
 * context-bound photo references that 403 for anyone but Wanderlog. The only
 * route to Google's POI imagery is to ask for a fresh photo name ourselves.
 *
 * Google forbids caching the image or the name (ToS 3.2.3(b)), and the name
 * expires, so this runs on every ingest and the image is fetched live in the
 * browser. Consequences, accepted deliberately: no photos offline, and the
 * browser key is visible in the built app (restrict it by HTTP referrer).
 */

const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";
/** Enough for a card thumbnail without paying for pixels nobody sees. */
const REQUEST_CONCURRENCY = 6;

export type PhotoFetchReport = {
  requested: number;
  attached: number;
  failed: number;
  skipped: number;
  errors: string[];
};

type GooglePhoto = {
  name?: string;
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: { displayName?: string; uri?: string }[];
};

type PhotoResponse = { photos?: GooglePhoto[] };

/** Strip our `google-place:` prefix back to the bare Google place id. */
function googleId(place: { googlePlaceId?: string | undefined; id: string }): string | undefined {
  if (place.googlePlaceId) return place.googlePlaceId;
  const match = place.id.match(/^google-place:(.+)$/);
  return match?.[1];
}

async function fetchPhoto(placeId: string, apiKey: string): Promise<GooglePhoto | undefined> {
  const response = await fetch(`${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "photos",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 160)}`);
  }

  const json = (await response.json()) as PhotoResponse;
  return json.photos?.[0];
}

/** Run tasks with a small concurrency cap so a big trip does not burst. */
async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<void>) {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run));
  }
}

export async function attachPlacePhotos(
  bundle: TripBundle,
  apiKey: string | undefined,
): Promise<PhotoFetchReport> {
  const report: PhotoFetchReport = {
    requested: 0,
    attached: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  const places = Object.values(bundle.places);
  if (!apiKey) {
    report.skipped = places.length;
    return report;
  }

  await inBatches(places, REQUEST_CONCURRENCY, async (place) => {
    const placeId = googleId(place);
    if (!placeId) {
      report.skipped += 1;
      return;
    }

    report.requested += 1;
    try {
      const photo = await fetchPhoto(placeId, apiKey);
      if (!photo?.name) return;

      const attributions = (photo.authorAttributions ?? [])
        .filter((entry): entry is { displayName: string; uri?: string } =>
          Boolean(entry.displayName),
        )
        .map((entry) => ({
          displayName: entry.displayName,
          ...(entry.uri ? { uri: entry.uri } : {}),
        }));

      place.photo = {
        name: photo.name,
        ...(photo.widthPx ? { widthPx: photo.widthPx } : {}),
        ...(photo.heightPx ? { heightPx: photo.heightPx } : {}),
        ...(attributions.length ? { attributions } : {}),
      };
      report.attached += 1;
    } catch (error) {
      report.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (report.errors.length < 5) report.errors.push(`${place.name}: ${message}`);
    }
  });

  return report;
}
