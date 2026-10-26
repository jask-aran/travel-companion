const ENDPOINT = "https://translation.googleapis.com/language/translate/v2";
/** The API takes up to 128 strings a request. */
const BATCH = 100;

export type TranslationReport = {
  translated: number;
  cached: number;
  model: "llm" | "standard";
  failed?: string;
};

export function translationModel(projectNumber?: string): string | undefined {
  return projectNumber
    ? `projects/${projectNumber}/locations/global/models/general/translation-llm`
    : undefined;
}

/**
 * English for each text, from the cache or the API. Without a key, or if the
 * API refuses, the missing ones are simply absent and show as given.
 */
export async function translateMissing(
  texts: Iterable<string>,
  apiKey: string | undefined,
  cache: Record<string, string>,
  model?: string,
): Promise<{ translations: Record<string, string>; report: TranslationReport }> {
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

  return { translations: Object.fromEntries(wanted.filter((text) => text in cache).map((text) => [text, cache[text]!])), report };
}
