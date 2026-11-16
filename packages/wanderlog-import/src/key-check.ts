import { staticMapUpstream } from "../../../apps/web/src/lib/media.js";
import { translationModel } from "../../trip-normaliser/src/translate-api.js";

/**
 * One small request to each API a key is for, to tell "works" from "refused,
 * and why" before the key goes to Cloudflare. Costs: a Places lookup of the
 * place id only, one small street map, one transit route, the translation
 * of one word, and one NAVITIME route (one of the plan's month). Results
 * never contain a key.
 */

export type Keys = { googleKey?: string | undefined; googleProject?: string | undefined; navitimeKey?: string | undefined };
export type KeyCheck = { name: string; ok: boolean; detail: string };

/** Tokyo and Shinjuku stations: a route every provider can answer. */
const TOKYO = { latitude: 35.6812, longitude: 139.7671 };
const SHINJUKU = { latitude: 35.6896, longitude: 139.7006 };
const latLng = (at: typeof TOKYO) => ({ location: { latLng: at } });
/** Google's own example place id (Sydney); asking for its id only is the cheapest Places request. */
const SAMPLE_PLACE = "ChIJN1t_tDeuEmsRUsoyG83frY4";

/** The provider's own words for a refusal: Google's error.message, or the start of the body. */
async function reason(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  let said = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    said = (typeof body.error === "object" ? body.error.message : body.error) ?? body.message ?? text;
  } catch {
    // Not JSON (Static Maps answers in plain text).
  }
  return `${response.status}: ${said.replace(/\s+/g, " ").trim().slice(0, 240) || response.statusText}`;
}

function tomorrowAtNine(): string {
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return `${day}T09:00:00`;
}

export async function checkKeys(keys: Keys, fetcher: typeof fetch = fetch): Promise<KeyCheck[]> {
  const checks: KeyCheck[] = [];
  const attempt = async (name: string, ask: () => Promise<Response>, works: string, check?: (response: Response) => Promise<string | undefined>) => {
    try {
      const response = await ask();
      if (!response.ok) return void checks.push({ name, ok: false, detail: await reason(response) });
      const problem = check ? await check(response) : (await response.body?.cancel(), undefined);
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true, detail: works });
    } catch (error) {
      checks.push({ name, ok: false, detail: `no answer (${error instanceof Error ? error.message : String(error)})` });
    }
  };
  const timeout = () => AbortSignal.timeout(15_000);

  const google = keys.googleKey;
  if (google) {
    await attempt("Places API (New)", () => fetcher(`https://places.googleapis.com/v1/places/${SAMPLE_PLACE}`, {
      headers: { "X-Goog-Api-Key": google, "X-Goog-FieldMask": "id" }, signal: timeout(),
    }), "answers: place photos work");
    await attempt("Maps Static API", () => fetcher(staticMapUpstream(`${TOKYO.latitude},${TOKYO.longitude}`, google), { signal: timeout() }),
      "answers: street maps work", async (response) => {
        const type = response.headers.get("content-type") ?? "";
        await response.body?.cancel();
        return type.startsWith("image/") ? undefined : `answered ${type || "no type"}, not an image`;
      });
    await attempt("Routes API", () => fetcher("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": google, "X-Goog-FieldMask": "routes.duration" },
      body: JSON.stringify({ origin: latLng(TOKYO), destination: latLng(SHINJUKU), travelMode: "TRANSIT" }),
      signal: timeout(),
    }), "answers: transit times outside Japan work");
    const model = translationModel(keys.googleProject);
    await attempt(model ? "Cloud Translation (LLM)" : "Cloud Translation", () => fetcher(
      `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(google)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: ["新宿駅"], target: "en", format: "text", ...(model ? { model } : {}) }),
        signal: timeout(),
      },
    ), model ? "answers with the project's LLM: line and town names work" : "answers: line and town names work");
  }

  const navitime = keys.navitimeKey;
  if (navitime) {
    let left: string | null = null;
    const params = new URLSearchParams({
      start: `${TOKYO.latitude},${TOKYO.longitude}`,
      goal: `${SHINJUKU.latitude},${SHINJUKU.longitude}`,
      start_time: tomorrowAtNine(),
      limit: "1",
    });
    await attempt("NAVITIME (RapidAPI)", () => fetcher(`https://navitime-route-totalnavi.p.rapidapi.com/route_transit?${params}`, {
      headers: { "x-rapidapi-host": "navitime-route-totalnavi.p.rapidapi.com", "x-rapidapi-key": navitime },
      signal: timeout(),
    }), "answers: transit times in Japan work", async (response) => {
      // RapidAPI says how many of the plan's requests are left: worth seeing.
      left = response.headers.get("x-ratelimit-requests-remaining");
      await response.body?.cancel();
      return left !== null && Number(left) <= 0 ? "answers, but the plan's requests are used up" : undefined;
    });
    const last = checks.at(-1);
    if (last?.ok && left !== null) last.detail += ` (${left} of the plan's requests left)`;
  }
  return checks;
}

/** `abcd…wxyz`: enough to tell two keys apart, not enough to use one. */
export function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 8 ? "set" : `set (…${key.slice(-4)})`;
}

export function formatKeyChecks(checks: KeyCheck[]): string {
  const width = Math.max(...checks.map((check) => check.name.length));
  return checks.map((check) => `  ${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}`).join("\n");
}
