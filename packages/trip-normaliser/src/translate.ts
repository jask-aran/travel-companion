import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Google Cloud Translation (v2) for the line, stop and direction names the
 * departure providers return in Japanese or Korean. Each name is translated
 * once and kept in a cache file, so a re-pull only pays for new names.
 */

const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
/** The API takes up to 128 strings a request. */
const BATCH = 100;

export type TranslationReport = { translated: number; cached: number; failed?: string };

async function readCache(path: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
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
): Promise<{ translations: Record<string, string>; report: TranslationReport }> {
  const cache = await readCache(cachePath);
  const wanted = [...new Set(texts)];
  const missing = wanted.filter((text) => !(text in cache));
  const report: TranslationReport = { translated: 0, cached: wanted.length - missing.length };

  if (apiKey && missing.length) {
    try {
      for (let index = 0; index < missing.length; index += BATCH) {
        const batch = missing.slice(index, index + BATCH);
        const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: batch, target: "en", format: "text" }),
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
  await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
  return { translations: Object.fromEntries(wanted.filter((text) => text in cache).map((text) => [text, cache[text]!])), report };
}
