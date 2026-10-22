import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
/** The API takes up to 128 strings a request. */
const BATCH = 100;

export type TranslationReport = {
  translated: number;
  cached: number;
  model: "llm" | "standard";
  failed?: string;
};

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
  const model = projectNumber
    ? `projects/${projectNumber}/locations/global/models/general/translation-llm`
    : undefined;
  const store = await readCache(cachePath);
  const cache = (store[model ?? "nmt"] ??= {});
  const wanted = [...new Set(texts)];
  const missing = wanted.filter((text) => !(text in cache));
  const report: TranslationReport = {
    translated: 0,
    cached: wanted.length - missing.length,
    model: model ? "llm" : "standard",
  };

  if (apiKey && missing.length) {
    try {
      for (let index = 0; index < missing.length; index += BATCH) {
        const batch = missing.slice(index, index + BATCH);
        const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: batch, target: "en", format: "text", ...(model ? { model } : {}) }),
        });
        if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
        const json = (await response.json()) as {
          data?: { translations?: { translatedText?: string }[] };
        };
        json.data?.translations?.forEach((entry, offset) => {
          const text = batch[offset];
          if (text && entry.translatedText) {
            cache[text] = entry.translatedText;
            report.translated += 1;
          }
        });
      }
    } catch (error) {
      report.failed = error instanceof Error ? error.message : String(error);
    }
  }

  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return { translations: Object.fromEntries(wanted.filter((text) => text in cache).map((text) => [text, cache[text]!])), report };
}
