import tzLookup from "@photostructure/tz-lookup";

/**
 * A place's time zone from its coordinates, offline. Wanderlog gives
 * ordinary stops only a name, coordinates and an address; the UTC offset it
 * sometimes carries is the offset on the day it was fetched, which daylight
 * saving can make wrong by the travel date. A zone name lets the offset be
 * worked out for the date that matters.
 */
export function zoneAt(latitude: number | undefined, longitude: number | undefined): string | undefined {
  if (latitude === undefined || longitude === undefined) return undefined;
  try {
    return tzLookup(latitude, longitude);
  } catch {
    return undefined;
  }
}

/** Local time minus UTC, in minutes, in `zone` at a local date and time. */
export function offsetMinutes(zone: string, isoDate: string, time = "12:00"): number | undefined {
  const instant = Date.parse(`${isoDate}T${time}:00Z`);
  if (Number.isNaN(instant)) return undefined;
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(new Date(instant))
      .find((part) => part.type === "timeZoneName")?.value;
    const match = /GMT(?:([+-])(\d{2}):(\d{2}))?/.exec(name ?? "");
    if (!match) return undefined;
    if (!match[1]) return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
  } catch {
    return undefined;
  }
}
