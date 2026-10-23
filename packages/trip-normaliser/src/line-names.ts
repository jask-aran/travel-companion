/**
 * Line and stop names as the providers give them, tidied for display and
 * translation. NAVITIME's marketplace plan answers only in Japanese, and
 * Google names some Korean lines in Korean whatever language is asked for,
 * so names in either script are machine-translated at pull time (translate.ts)
 * and shown in English with the original kept beside them.
 */

/** Japanese kana and kanji, or Korean hangul: text worth translating. */
const LOCAL_SCRIPT = /[぀-ヿ㐀-鿿가-힯]/;

export const needsTranslation = (text: string) => LOCAL_SCRIPT.test(text);

/**
 * Full-width letters and digits ("ＪＲ") as plain ASCII, and without the
 * stretch NAVITIME appends to a line ("JR高山本線(岐阜-美濃太田)"), which
 * would otherwise be translated into a different name per stretch.
 */
export function localLineName(raw: string): string {
  return raw.normalize("NFKC").replace(/\((?:[^()]*-[^()]*)\)$/, "").trim();
}

/** A Korean headsign reads "서울역 방면", "bound for Seoul Station". */
export function localHeadsign(raw: string | undefined): string | undefined {
  const text = raw?.normalize("NFKC").replace(/\s*방면$/, "").trim();
  return text || undefined;
}

/**
 * The English name for a local one: Seoul Metro's numbered lines by rule
 * (a translator renders "2호선" as "Line 2" or "No. 2 Line" at random),
 * everything else from the translations fetched for the trip.
 */
export function englishName(local: string, translations: Record<string, string>): string {
  const seoul = /^(\d+)호선$/.exec(local);
  if (seoul) return `Line ${seoul[1]}`;
  return translations[local] ?? local;
}

const KANA_KANJI = /[぀-ヿ㐀-鿿]/;

/**
 * A Japanese station name as asked of the translator. Bare, a name is read
 * as words (白子, Shiroko, comes back "White piece"); as "白子駅" it is read
 * as a place and romanised.
 */
export const stationQuery = (local: string) =>
  KANA_KANJI.test(local) && !/駅$/.test(local) ? `${local}駅` : local;

/** The English name for a station, without the "Station" the query added. */
export function englishStation(local: string, translations: Record<string, string>): string {
  const query = stationQuery(local);
  const english = translations[query];
  if (!english) return local;
  return query === local ? english : english.replace(/\s+Station$/i, "");
}
