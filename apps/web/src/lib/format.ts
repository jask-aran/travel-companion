const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

const weekdayFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
});

const dayMonthFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/** Parse a trip ISO date as a calendar date, not a UTC instant. */
export function parseTripDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

export function formatDayHeading(isoDate: string): string {
  return dayFormatter.format(parseTripDate(isoDate));
}

export function formatTabWeekday(isoDate: string): string {
  return weekdayFormatter.format(parseTripDate(isoDate));
}

export function formatTabDayMonth(isoDate: string): string {
  return dayMonthFormatter.format(parseTripDate(isoDate));
}

export function formatTripRange(startDate: string, endDate: string): string {
  const start = formatDayHeading(startDate);
  const end = formatDayHeading(endDate);
  return `${start} – ${end}`;
}

export function formatDuration(seconds?: number): string | undefined {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  // Match Wanderlog, which shows "< 1 min" rather than rounding to "0 min".
  if (seconds < 60) return "< 1 min";
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

export function formatDistance(metres?: number): string | undefined {
  if (metres == null || !Number.isFinite(metres) || metres <= 0) return undefined;
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return `${km >= 100 ? Math.round(km) : km.toFixed(1)} km`;
}

export function formatTravelMode(mode: string): string {
  switch (mode) {
    case "walking":
      return "Walk";
    case "transit":
      return "Transit";
    case "driving":
      return "Drive";
    case "cycling":
      return "Cycle";
    case "ferry":
      return "Ferry";
    case "flight":
      return "Flight";
    default:
      return mode;
  }
}

const lodgingDateFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

export function formatLodgingDate(isoDate: string): string {
  return lodgingDateFormatter.format(parseTripDate(isoDate));
}

/** Whole nights between ISO calendar dates; undefined if either missing/invalid. */
export function nightsBetween(checkIn?: string, checkOut?: string): number | undefined {
  if (!checkIn || !checkOut) return undefined;
  const start = parseTripDate(checkIn).getTime();
  const end = parseTripDate(checkOut).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
  return Math.round((end - start) / 86_400_000);
}

/** Wanderlog day titles carry typed-out arrows; render them properly. */
export function formatArrows(text: string): string {
  return text.replace(/\s*-{1,2}>\s*/g, " → ");
}

function compactCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

/** "4.3 · 29.6k" — rating is only meaningful alongside how many rated it. */
export function formatRating(rating?: number, ratingCount?: number): string | undefined {
  if (rating == null || !Number.isFinite(rating) || rating <= 0) return undefined;
  const score = rating.toFixed(1);
  if (ratingCount == null || ratingCount <= 0) return score;
  return `${score} · ${compactCount(ratingCount)}`;
}

/**
 * Google addresses arrive with the country appended, a postal code inline, and
 * — for Japanese addresses — the block number repeated in romaji and kanji.
 * None of that helps on a card: "Open in Maps" is one tap away, so what's
 * wanted here is a short locality that orients you. Keep the broadest few
 * named parts and drop codes and block numbers entirely.
 */
const COUNTRY = /^(japan|south korea|korea)$/i;
const POSTAL = /^\u3012?\d{3}-?\d{4}$/;
/** Block numbers: digits, dashes and Japanese counter kanji, but no name. */
const BLOCK_ONLY = /^[\d\s\u2212\u2013-]*[\u756a\u53f7\u4e01\u76ee\d\s\u2212\u2013-]*$/;

export function cleanAddress(address?: string): string | undefined {
  if (!address?.trim()) return undefined;

  const parts: string[] = [];
  for (const rawPart of address.split(",")) {
    const tokens = rawPart
      .trim()
      .split(/\s+/)
      .filter((token) => !POSTAL.test(token));
    // Drop a leading block number so "49-1 Hatotani" reads as "Hatotani".
    while (tokens.length > 1 && /^[\d\u2212\u2013-]+$/.test(tokens[0] ?? "")) tokens.shift();
    const part = tokens.join(" ").trim();
    if (!part) continue;
    if (COUNTRY.test(part)) continue;
    if (BLOCK_ONLY.test(part)) continue;
    if (!parts.includes(part)) parts.push(part);
  }

  return parts.slice(0, 3).join(", ") || undefined;
}

/**
 * Wanderlog writes the passenger list into a flight's free-text note as well
 * as its structured `travelerNames`. Once the names are shown as a field, the
 * note is the same information in prose — drop it rather than print it twice.
 */
export function noteRestatesNames(note: string | undefined, names?: string[]): boolean {
  if (!note?.trim() || !names?.length) return false;
  const haystack = note.toLowerCase();
  if (!names.every((name) => haystack.includes(name.toLowerCase()))) return false;
  // Only a note that is *nothing but* the list; anything extra is worth keeping.
  const residue = names
    .reduce((text, name) => text.replaceAll(name.toLowerCase(), ""), haystack)
    .replace(/\b(for|and)\b|[,.\s]/g, "");
  return residue.length === 0;
}

/**
 * Opening hours for one weekday, taken from Google's `day` numbering where
 * 0 is Sunday. A place can open more than once in a day (a restaurant that
 * shuts between lunch and dinner), so windows are joined rather than reduced
 * to a single span.
 *
 * Returns undefined when the data says nothing about that day — which is not
 * the same as "closed", so the caller must not render it as such.
 */
export function formatOpeningForDay(
  periods: { day: number; open: string; close?: string | undefined }[] | undefined,
  weekday: number,
): string | undefined {
  if (!periods?.length) return undefined;
  const forDay = periods.filter((period) => period.day === weekday);
  if (!forDay.length) return undefined;

  // A window opening at 00:00 with no close is Google's "open 24 hours".
  if (forDay.length === 1 && forDay[0]?.open === "00:00" && !forDay[0]?.close) {
    return "Open 24 hours";
  }

  return forDay
    .map((period) => (period.close ? `${period.open}–${period.close}` : `from ${period.open}`))
    .join(", ");
}

/** "45 min" or "1–2 h" for Wanderlog's typical-visit estimate. */
export function formatVisitLength(min?: number, max?: number): string | undefined {
  const low = min ?? max;
  const high = max ?? min;
  if (low == null || high == null || low <= 0) return undefined;
  const label = (minutes: number) =>
    minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
  return low === high ? label(low) : `${label(low)}–${label(high)}`;
}
