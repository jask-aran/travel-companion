/**
 * A place's current first photo from Google (Place Details, photos field
 * only), for the worker's `api/photo`. Wanderlog's own image URLs 403 for
 * anyone but Wanderlog.
 */

const DETAILS_ENDPOINT = "https://places.googleapis.com/v1/places";

type GooglePhoto = {
  name?: string;
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: { displayName?: string; uri?: string }[];
};

type PhotoResponse = { photos?: GooglePhoto[] };

/**
 * A place's current first photo, or undefined if Google has none. `fetcher`
 * is the caller's: the worker's checks every Google request (guard.ts).
 */
export async function fetchPhoto(
  placeId: string,
  apiKey: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<GooglePhoto | undefined> {
  const response = await fetcher(`${DETAILS_ENDPOINT}/${encodeURIComponent(placeId)}`, {
    headers: {
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "photos",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    // The status rides along so the worker can tell "no such place" from "refused".
    throw Object.assign(new Error(`${response.status} ${response.statusText}: ${body.slice(0, 160)}`), {
      status: response.status,
    });
  }

  const json = (await response.json()) as PhotoResponse;
  return json.photos?.[0];
}
