import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { translationModel, translateMissing, type TranslationReport } from "./translate-api.js";

export type { TranslationReport } from "./translate-api.js";

/**
 * Google Cloud Translation for the line, stop and direction names the
 * departure providers return in Japanese or Korean. Each name is translated
 * once and kept in a cache file, so a re-pull only pays for new names.
 *
 * With a project number it asks Google's Translation LLM through the Basic
 * endpoint (an API key is enough there). The standard model reads proper
 * names as words: the Hida express (ひだ) comes back as "pleats". The LLM
 * costs the same per character, and a trip's names are a few hundred.
 */

/** Translations per model, so a model change never serves the other's answers. */
type Cache = Record<string, Record<string, string>>;

async function readCache(path: string): Promise<Cache> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Record<string, string>] =>
        Boolean(entry[1]) && typeof entry[1] === "object",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * English for each text, from the cache or the API. Without a key, or if the
 * API refuses, the missing ones are simply absent and show as given.
 */
export async function translateNames(
  texts: Iterable<string>,
  apiKey: string | undefined,
  cachePath: string,
  projectNumber?: string,
): Promise<{ translations: Record<string, string>; report: TranslationReport }> {
  const model = translationModel(projectNumber);
  const store = await readCache(cachePath);
  const cache = (store[model ?? "nmt"] ??= {});
  const result = await translateMissing(texts, apiKey, cache, model);

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return result;
}

/**
 * Places Google names only in Japanese or Korean (Takayama Station's town is
 * 高山市), in English, through the same cached translation as line names.
 * "Takayama City" reads as "Takayama", as the other towns do.
 */
export async function englishLocalities(
  bundle: { places: Record<string, { locality?: string | undefined }> },
  apiKey: string | undefined,
  cachePath: string,
  projectNumber?: string,
): Promise<number> {
  const local = Object.values(bundle.places).filter((place) => place.locality && LOCAL_SCRIPT.test(place.locality));
  if (!local.length) return 0;
  const { translations } = await translateNames(
    local.map((place) => place.locality!),
    apiKey,
    cachePath,
    projectNumber,
  );
  let translated = 0;
  for (const place of local) {
    const english = translations[place.locality!];
    if (!english) continue;
    place.locality = english.replace(/\s+City$/i, "");
    translated += 1;
  }
  return translated;
}

const LOCAL_SCRIPT = /[぀-ヿ㐀-鿿가-힯]/;
