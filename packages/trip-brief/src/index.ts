import type {
  DayItem,
  DepartureBoard,
  FlightItem,
  LodgingItem,
  Place,
  RouteLeg,
  TripBundle,
  TripDay,
} from "../../trip-schema/src/index.js";
import {
  formatArrows,
  formatCategory,
  formatDayHeading,
  formatDistance,
  formatDuration,
  formatLodgingDate,
  formatOpeningForDay,
  formatTravelMode,
  formatTripRange,
  nightsBetween,
  noteRestatesNames,
  parseTripDate,
} from "../../../apps/web/src/lib/format.js";
import { collectStays, stayDisplay, stayKey, type Stay } from "../../../apps/web/src/lib/lodging.js";
import { indexRouteLegs, type RouteLegIndex } from "../../../apps/web/src/lib/route-legs.js";
import { dayRouting } from "../../../apps/web/src/lib/day-routing.js";
import { departureKey } from "../../../apps/web/src/lib/departure-targets.js";
import { pickDeparture } from "../../../apps/web/src/lib/departure-pick.js";
import { buildGooglePlaceUrl } from "../../../apps/web/src/lib/maps.js";

/** The trip as Markdown for a chat agent; polylines, photos and internal ids are left out. */

type Context = {
  bundle: TripBundle;
  stays: Stay[];
  legIndex: RouteLegIndex;
};

function contextOf(bundle: TripBundle): Context {
  return { bundle, stays: collectStays(bundle), legIndex: indexRouteLegs(bundle) };
}

export function tripDates(bundle: TripBundle): string[] {
  return bundle.days.map((day) => day.date).sort();
}

export function tripBrief(bundle: TripBundle): string {
  const context = contextOf(bundle);
  const days = [...bundle.days].sort((a, b) => a.date.localeCompare(b.date));
  return [header(bundle), ...days.map((day) => renderDay(context, day))].join("\n\n") + "\n";
}

/**
 * One day, or with `through` every day from `date` to `through` inclusive.
 * Undefined when either date is not a trip day or `through` comes first.
 */
export function dayBrief(bundle: TripBundle, date: string, through?: string): string | undefined {
  const dates = tripDates(bundle);
  if (!dates.includes(date)) return undefined;
  if (through !== undefined && (!dates.includes(through) || through < date)) return undefined;
  const last = through ?? date;
  const context = contextOf(bundle);
  const days = [...bundle.days]
    .filter((day) => day.date >= date && day.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date));
  return days.map((day) => renderDay(context, day)).join("\n\n") + "\n";
}

/**
 * A short first read: one line per day (town, bed, stop count, flights),
 * then where to look for more.
 */
export function tripOverview(bundle: TripBundle): string {
  const context = contextOf(bundle);
  const days = [...bundle.days].sort((a, b) => a.date.localeCompare(b.date));
  const lines = days.map((day) => {
    const routing = dayRouting(bundle, day, context.stays, context.legIndex);
    const title = formatArrows(day.title);
    const stops = day.items.filter((item) => item.type === "place").length;
    const parts = [
      `- ${formatDayHeading(day.date)} (${day.date})${title && title !== day.date ? ` — ${title}` : ""}`,
      routing.sleepsIn ? `sleep at ${stayName(bundle, routing.sleepsIn.name, routing.sleepsIn.placeId)}` : undefined,
      `${stops} stop${stops === 1 ? "" : "s"}`,
      ...routing.flights.map((flight) => `flight ${flightSummary(context, flight)}`),
    ];
    return parts.filter(Boolean).join("; ");
  });
  return [
    header(bundle),
    "",
    "## Days",
    ...lines,
    "",
    "For full detail of a date or a run of dates (stops, times, opening hours, notes, and how to get between stops with departure times) call `get_day`. For every booking reference, flight and stay (with cancellation terms) call `get_bookings`.",
  ].join("\n") + "\n";
}

/** Every flight and every stay once, in date order, with all their booking data. */
export function tripBookings(bundle: TripBundle): string {
  const context = contextOf(bundle);
  const flights = new Map<string, FlightItem>();
  for (const day of bundle.days) {
    for (const item of day.items) if (item.type === "flight" && !flights.has(item.id)) flights.set(item.id, item);
  }
  const entries: Array<{ sort: string; lines: string[] }> = [
    ...[...flights.values()].map((flight) => ({
      sort: `${flight.departDate ?? ""} ${flight.departTime ?? ""}`,
      lines: flightLines(context, flight),
    })),
    ...context.stays.map((stay) => ({ sort: `${stay.checkInDate} 99:99`, lines: stayBookingLines(context, stay) })),
  ].sort((a, b) => a.sort.localeCompare(b.sort));
  const { title } = bundle.trip;
  return [
    `# ${title}: bookings`,
    "",
    `Every flight and stay, in date order. Itinerary generated ${bundle.generatedAt}. Times are local clock times.`,
    "",
    ...entries.map((entry) => entry.lines.join("\n")),
  ].join("\n") + "\n";
}

/** The lodging items that make up one stay, as `collectStays` grouped them. */
function stayItems(bundle: TripBundle, stay: Stay): LodgingItem[] {
  return bundle.days
    .flatMap((day) => day.items)
    .filter(
      (item): item is LodgingItem =>
        item.type === "lodging" && Boolean(item.checkInDate && item.checkOutDate) && stayKey(item) === stay.key,
    );
}

function stayBookingLines(context: Context, stay: Stay): string[] {
  const { bundle } = context;
  const items = stayItems(bundle, stay);
  const first = <K extends keyof LodgingItem>(key: K): LodgingItem[K] | undefined =>
    items.find((item) => item[key] !== undefined)?.[key];
  const nights = nightsBetween(stay.checkInDate, stay.checkOutDate);
  const checkInTime = items.find((item) => item.phase === "check-in")?.startTime;
  const checkOutTime = items.find((item) => item.phase === "check-out")?.endTime;
  const lines = [
    `- Stay: ${stayName(bundle, stay.name, stay.placeId)}`,
    `  Check in ${formatLodgingDate(stay.checkInDate)} (${stay.checkInDate})${checkInTime ? ` from ${checkInTime}` : ""}; check out ${formatLodgingDate(stay.checkOutDate)} (${stay.checkOutDate})${checkOutTime ? ` by ${checkOutTime}` : ""}${nights ? `; ${nights} night${nights === 1 ? "" : "s"}` : ""}`,
  ];
  const confirmation = first("confirmationNumber");
  if (confirmation) lines.push(`  Booking reference: ${confirmation}`);
  const travellers = first("travellerNames");
  if (travellers?.length) lines.push(`  Travellers: ${travellers.join(", ")}`);
  lines.push(...lodgingBookingDetail(first("guests"), first("cancellationDeadline"), first("cancellationPolicy"), first("bookingEmailSubject")));
  const contact = [first("phone") && `Phone ${first("phone")}`, bareUrl(first("website"))].filter(Boolean);
  if (contact.length) lines.push(`  ${contact.join(" · ")}`);
  const place = stay.placeId ? bundle.places[stay.placeId] : undefined;
  if (place) {
    const where = [place.address, place.locality].filter(Boolean).join(" · ");
    if (where) lines.push(`  ${where}`);
    lines.push(`  Map: ${buildGooglePlaceUrl(place)}`);
  }
  return lines;
}

function guestsText(guests: LodgingItem["guests"]): string | undefined {
  if (!guests) return undefined;
  const count = (n: number | undefined, word: string) => (n === undefined ? undefined : `${n} ${word}${n === 1 ? "" : "s"}`);
  const children = guests.childrenAges?.length
    ? `${guests.childrenAges.length} child${guests.childrenAges.length === 1 ? "" : "ren"} (aged ${guests.childrenAges.join(", ")})`
    : undefined;
  const parts = [count(guests.adultCount, "adult"), children, count(guests.roomCount, "room")].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

function lodgingBookingDetail(
  guests: LodgingItem["guests"],
  deadline: string | undefined,
  policy: string | undefined,
  subject: string | undefined,
): string[] {
  const lines: string[] = [];
  const guestText = guestsText(guests);
  if (guestText) lines.push(`  Guests: ${guestText}`);
  if (deadline) lines.push(`  Free cancellation deadline: ${deadline} (hotel local time)`);
  if (policy) lines.push(`  Cancellation policy: ${policy.replace(/\s*\n\s*/g, " ")}`);
  if (subject) lines.push(`  Booking email subject: "${subject}"`);
  return lines;
}

function header(bundle: TripBundle): string {
  const { title, startDate, endDate } = bundle.trip;
  return [
    `# ${title}`,
    "",
    `${formatTripRange(startDate, endDate)} ${startDate.slice(0, 4)} (${startDate} to ${endDate}), ${bundle.days.length} days.`,
    `Itinerary generated ${bundle.generatedAt}.`,
    "All times are local clock times in each day's time zone. Route legs (→) are travel between consecutive stops.",
  ].join("\n");
}

const placeName = (bundle: TripBundle, placeId: string | undefined): string =>
  (placeId && bundle.places[placeId]?.name) || "unnamed place";

function stayName(bundle: TripBundle, name: string, placeId?: string): string {
  const place = placeId ? bundle.places[placeId] : undefined;
  const shown = stayDisplay(name, place);
  return shown.name === name ? name : `${shown.name} (${name})`;
}

function timeRange(item: DayItem): string | undefined {
  if (item.startTime && item.startTime === item.endTime) return item.startTime;
  if (item.startTime && item.endTime) return `${item.startTime}–${item.endTime}`;
  if (item.startTime) return `from ${item.startTime}`;
  if (item.endTime) return `until ${item.endTime}`;
  return undefined;
}

/** Notes keep their Markdown; indented so they stay inside the list item. */
function notesBlock(notes: string | undefined, indent = "  "): string[] {
  const text = notes?.trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  return [`${indent}Notes:`, ...lines.map((line) => (line ? `${indent}  ${line}` : ""))];
}

/** Tracking query strings say nothing to the reader; drop them. */
function bareUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/\?.*$/, (query) => (/utm_|gclid|fbclid/.test(query) ? "" : query));
}

const BOARD_ROWS = 4;

function placeDetailLines(place: Place, date: string, indent = "  "): string[] {
  const lines: string[] = [];
  const where = [place.address, place.locality].filter(Boolean);
  const category = formatCategory(place.category);
  const meta = [category, ...where].filter(Boolean).join(" · ");
  if (meta) lines.push(`${indent}${meta}`);
  const details = place.details;
  if (details?.permanentlyClosed) lines.push(`${indent}Permanently closed.`);
  else if (details?.businessStatus && details.businessStatus !== "OPERATIONAL") {
    lines.push(`${indent}Status: ${details.businessStatus}`);
  }
  const hours = formatOpeningForDay(details?.openingPeriods, parseTripDate(date).getDay());
  if (hours) lines.push(`${indent}Hours that day: ${hours}`);
  if (details?.summary) lines.push(`${indent}${details.summary}`);
  const contact = [details?.phone && `Phone ${details.phone}`, bareUrl(details?.website)].filter(Boolean);
  if (contact.length) lines.push(`${indent}${contact.join(" · ")}`);
  lines.push(`${indent}Map: ${buildGooglePlaceUrl(place)}`);
  return lines;
}

function legLine(context: Context, leg: RouteLeg, from: string, to: string, notBefore?: string): string[] {
  const facts = [formatDuration(leg.durationSeconds), formatDistance(leg.distanceMetres)].filter(Boolean);
  const board = context.bundle.departures?.[departureKey(leg)];
  // A line's first mention carries its local name too, as station signs and timetables show it.
  const lines =
    board?.options.flatMap((option) =>
      option.segments.map((segment) =>
        segment.nameLocal && segment.nameLocal !== segment.name ? `${segment.name} (${segment.nameLocal})` : segment.name,
      ),
    ) ?? [];
  const lineNames = [...new Set(lines)];
  const line = [
    `- → ${formatTravelMode(leg.travelMode)} ${from} to ${to}`,
    facts.length ? `: ${facts.join(", ")}` : "",
    lineNames.length ? ` (lines: ${lineNames.slice(0, 4).join(", ")})` : "",
  ].join("");
  return [line, ...(board ? boardLines(board, notBefore) : [])];
}

/** The listed departures, the one the app recommends marked. */
function boardLines(board: DepartureBoard, notBefore?: string): string[] {
  const { option: pick, listed, missed } = pickDeparture(board, board.target.kind === "day" ? notBefore : undefined);
  if (!listed.length) return [];
  const { kind, time, until } = board.target;
  const aim =
    kind === "arrive"
      ? `arrive by ${until ? `${time}–${until}` : time}`
      : kind === "depart"
        ? `leave from ${time}`
        : "whole-day timetable";
  const notes = [board.approximate ? "times approximate" : undefined, missed].filter(Boolean);
  const out = [`  Departures (${aim}${notes.length ? `; ${notes.join("; ")}` : ""}):`];
  for (const option of listed.slice(0, BOARD_ROWS)) {
    const changes = Math.max(0, option.segments.length - 1);
    const rides = option.segments
      .map((segment) => {
        const span = [segment.from, segment.to].filter(Boolean).join(" → ");
        return `${segment.name}${segment.headsign ? ` towards ${segment.headsign}` : ""}${span ? ` (${span})` : ""}`;
      })
      .join(", then ");
    const walk = option.walkMinutes ? `, ${option.walkMinutes} min walk first` : "";
    out.push(
      `  - ${option.departTime}→${option.arriveTime} (${option.minutes} min${walk}, ${changes} change${changes === 1 ? "" : "s"}): ${rides}${option === pick ? " [suggested]" : ""}`,
    );
  }
  const later = listed.slice(BOARD_ROWS).map((option) => option.departTime);
  if (later.length) out.push(`  - later departures: ${later.join(", ")}`);
  return out;
}

const flightNumber = (flight: FlightItem): string =>
  [flight.airlineCode ?? flight.airline, flight.flightNumber].filter(Boolean).join(" ");

/** "TA 12 Alpha→Beta 14:00": a flight in a few words, for the overview. */
function flightSummary(context: Context, flight: FlightItem): string {
  const end = (code?: string, city?: string, placeId?: string) => city ?? code ?? placeName(context.bundle, placeId);
  return [
    flightNumber(flight),
    `${end(flight.departAirport, flight.departCity, flight.departPlaceId)}→${end(flight.arriveAirport, flight.arriveCity, flight.arrivePlaceId)}`,
    flight.departTime,
  ]
    .filter(Boolean)
    .join(" ");
}

function flightLines(context: Context, flight: FlightItem): string[] {
  const number = flightNumber(flight);
  const end = (code?: string, city?: string, placeId?: string) =>
    [city, code && `(${code})`].filter(Boolean).join(" ") || placeName(context.bundle, placeId);
  const depart = [flight.departDate, flight.departTime].filter(Boolean).join(" ");
  const arrive = [flight.arriveDate, flight.arriveTime].filter(Boolean).join(" ");
  const lines = [
    `- Flight ${number || ""}${flight.airline && flight.airlineCode ? ` (${flight.airline})` : ""}: ${end(flight.departAirport, flight.departCity, flight.departPlaceId)} ${depart} → ${end(flight.arriveAirport, flight.arriveCity, flight.arrivePlaceId)} ${arrive}`.replace(/ +/g, " "),
  ];
  if (flight.confirmationNumber) lines.push(`  Booking reference: ${flight.confirmationNumber}`);
  if (flight.travellerNames?.length) lines.push(`  Travellers: ${flight.travellerNames.join(", ")}`);
  if (flight.bookingEmailSubject) lines.push(`  Booking email subject: "${flight.bookingEmailSubject}"`);
  if (flight.status) lines.push(`  Status: ${flight.status}`);
  if (!noteRestatesNames(flight.notes, flight.travellerNames)) lines.push(...notesBlock(flight.notes));
  return lines;
}

function lodgingLines(context: Context, item: LodgingItem): string[] {
  const phase = item.phase === "check-in" ? "Check in" : item.phase === "check-out" ? "Check out" : "Staying";
  const lines = [`- ${phase}: ${stayName(context.bundle, item.name, item.placeId)}`];
  const nights = nightsBetween(item.checkInDate, item.checkOutDate);
  if (item.checkInDate || item.checkOutDate) {
    lines.push(
      `  Stay: ${item.checkInDate ? formatLodgingDate(item.checkInDate) : "?"} to ${item.checkOutDate ? formatLodgingDate(item.checkOutDate) : "?"}${nights ? ` (${nights} night${nights === 1 ? "" : "s"})` : ""}`,
    );
  }
  if (item.confirmationNumber) lines.push(`  Booking reference: ${item.confirmationNumber}`);
  if (item.travellerNames?.length) lines.push(`  Travellers: ${item.travellerNames.join(", ")}`);
  lines.push(...lodgingBookingDetail(item.guests, item.cancellationDeadline, item.cancellationPolicy, item.bookingEmailSubject));
  const contact = [item.phone && `Phone ${item.phone}`, bareUrl(item.website)].filter(Boolean);
  if (contact.length) lines.push(`  ${contact.join(" · ")}`);
  const place = item.placeId ? context.bundle.places[item.placeId] : undefined;
  if (place) {
    const where = [place.address, place.locality].filter(Boolean).join(" · ");
    if (where) lines.push(`  ${where}`);
    lines.push(`  Map: ${buildGooglePlaceUrl(place)}`);
  }
  if (!noteRestatesNames(item.notes, item.travellerNames)) lines.push(...notesBlock(item.notes));
  return lines;
}

function itemLines(context: Context, item: DayItem, date: string): string[] {
  const time = timeRange(item);
  const prefix = time ? `${time} ` : "";
  const status = item.status && item.status !== "confirmed" ? ` (${item.status})` : "";
  switch (item.type) {
    case "place": {
      const place = context.bundle.places[item.placeId];
      const lines = [`- ${prefix}${place?.name ?? "unnamed place"}${status}`];
      if (place) lines.push(...placeDetailLines(place, date));
      lines.push(...notesBlock(item.notes));
      return lines;
    }
    case "note":
      return [
        `- ${prefix}Note${status}:`,
        ...item.text.trim().split(/\r?\n/).map((line) => (line ? `  ${line}` : "")),
        ...(item.notes?.trim() === item.text.trim() ? [] : notesBlock(item.notes)),
      ];
    case "transit": {
      const leg = item.routeLegId ? context.bundle.routeLegs[item.routeLegId] : undefined;
      const label = item.label ?? (leg ? formatTravelMode(leg.travelMode) : "Transit");
      return [`- ${prefix}${label}${status}`, ...notesBlock(item.notes)];
    }
    case "flight":
      return flightLines(context, item);
    case "lodging":
      return lodgingLines(context, item);
  }
}

function renderDay(context: Context, day: TripDay): string {
  const { bundle } = context;
  const routing = dayRouting(bundle, day, context.stays, context.legIndex);
  const title = formatArrows(day.title);
  const out = [
    `## ${formatDayHeading(day.date)} ${day.date.slice(0, 4)} (${day.date})${title && title !== day.date ? ` — ${title}` : ""}`,
  ];
  if (day.subtitle) out.push(formatArrows(day.subtitle));
  out.push(`Time zone: ${day.timezone}`);
  const woke = routing.wokeInSlot?.stay;
  if (woke) out.push(`Wake up at: ${stayName(bundle, woke.name, woke.placeId)}`);
  if (routing.sleepsIn) out.push(`Sleep at: ${stayName(bundle, routing.sleepsIn.name, routing.sleepsIn.placeId)}`);

  const lodging = day.items.filter((item): item is LodgingItem => item.type === "lodging");
  if (lodging.length) {
    out.push("", "### Lodging");
    for (const item of lodging) out.push(...lodgingLines(context, item));
  }

  if (routing.flights.length) {
    out.push("", "### Flights");
    for (const flight of routing.flights) {
      out.push(...flightLines(context, flight));
      const timing = routing.timings.get(flight.id);
      if (timing) {
        out.push(
          `  At the airport ${timing.airportBy}–${timing.airportUntil}${timing.leaveBy ? `; leave by ${timing.leaveBy}${timing.fromHotel ? " from the hotel" : ""}` : ""}`,
        );
      }
    }
  }

  if (routing.routeItems.length) {
    out.push("", "### Plan");
    let previous = woke ? stayName(bundle, woke.name, woke.placeId) : undefined;
    // When the plan has you free to leave: the last time it names, as the app's board does.
    let lastTime: string | undefined;
    for (const item of routing.routeItems) {
      if (item.type === "place") {
        const leg = routing.legs.get(item.id);
        const name = placeName(bundle, item.placeId);
        if (leg) out.push(...legLine(context, leg, placeName(bundle, leg.fromPlaceId) || previous || "", name, lastTime));
        previous = name;
        // Airports added for a flight carry no item of their own on the day.
        if (item.id.startsWith("airport:")) {
          out.push(`- ${name} (airport for the day's flight)`);
          continue;
        }
      }
      out.push(...itemLines(context, item, day.date));
      lastTime = item.endTime ?? item.startTime ?? lastTime;
    }
    if (routing.endLeg && routing.sleepsIn) {
      out.push(
        ...legLine(
          context,
          routing.endLeg,
          placeName(bundle, routing.endLeg.fromPlaceId),
          stayName(bundle, routing.sleepsIn.name, routing.sleepsIn.placeId),
          lastTime,
        ),
      );
    }
  }
  return out.join("\n");
}
