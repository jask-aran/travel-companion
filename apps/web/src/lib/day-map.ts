import type { DayItem, Place, RouteLeg, TripBundle } from "@travel-companion/trip-schema";
import type { DayRouting } from "./day-routing.js";
import { bindFlights } from "./flight-binding.js";
import type { MapTheme } from "./map-style.js";

export type MapPoint = [latitude: number, longitude: number];
export type MapStopKind = "hotel" | "airport" | "station" | "poi";
export type MapVisit = {
  id: string;
  place: Place;
  point: MapPoint;
  label: string;
  kind: MapStopKind;
  time: string | undefined;
};
export type MapStop = { place: Place; point: MapPoint; labels: string[]; roles: string[] };
export type MapPath = {
  fromPlaceId: string;
  toPlaceId: string;
  /** The visits at each end: a place visited twice has one stop but two visits. */
  fromVisitId: string | undefined;
  toVisitId: string | undefined;
  points: MapPoint[];
  mode: RouteLeg["travelMode"] | "connection";
  approximate: boolean;
  durationSeconds: number | undefined;
  distanceMetres: number | undefined;
  /** The route leg itself, for the step card's departure board; none for flights and bare connections. */
  leg: RouteLeg | undefined;
  /** Where the day's departure plans file this leg: the arriving item's id, or "end" for the way home. */
  planKey: string | undefined;
};
/** Route line colours; `dark` is for the dark base map. Walks are slate so they don't read as the green Start pin. */
export const MAP_MODES: Record<MapPath["mode"], { label: string; colour: string; dark: string }> = {
  walking: { label: "Walk", colour: "#4d6275", dark: "#b3c2d0" },
  transit: { label: "Transit", colour: "#246caa", dark: "#5fa2e0" },
  driving: { label: "Drive", colour: "#9a6018", dark: "#e0a052" },
  cycling: { label: "Cycle", colour: "#4d6275", dark: "#b3c2d0" },
  ferry: { label: "Ferry", colour: "#246caa", dark: "#5fa2e0" },
  flight: { label: "Flight", colour: "#8550a1", dark: "#c193dc" },
  connection: { label: "Connection", colour: "#8a7f6c", dark: "#c9bda8" },
};
export type DayMapData = { stops: MapStop[]; visits: MapVisit[]; paths: MapPath[]; missingPlaces: number };
export type DayMapView = {
  /** The whole day (or the ground route), every leg at full strength. */
  fit(includeFlights?: boolean): void;
  /** A leg step: frame the leg that arrives at this visit and fade the others. */
  focusLeg(visitId: string): void;
  /** A stop step: the stop close up, every leg at full strength. */
  focusStop(visitId: string): void;
  highlight(visitId: string): void;
  setTheme(theme: MapTheme): void;
  /** Map mode: one finger moves the map instead of the page. */
  setInteractive(on: boolean): void;
  retry(): void;
  destroy(): void;
};

export function stopKind(place: Place, hotels: Set<string>): MapStopKind {
  if (hotels.has(place.id)) return "hotel";
  if (place.category?.includes("airport")) return "airport";
  if (place.category?.includes("station") || place.category === "bus_stop" || place.category === "ferry_terminal") return "station";
  return "poi";
}

/** Flights stay in the whole-day view; the first view explains the ground journey. */
export function dayMapPoints(data: DayMapData, includeFlights: boolean): MapPoint[] {
  if (!includeFlights) {
    const ground = data.paths.filter((path) => path.mode !== "flight").flatMap((path) => path.points);
    if (ground.length) return ground;
  }
  return [...data.stops.map((stop) => stop.point), ...data.paths.flatMap((path) => path.points)];
}

/** The leg that arrives at a visit, if the map draws one. */
export function legInto(data: DayMapData, visitId: string, includeFlights: boolean): MapPath | undefined {
  return data.paths.find((path) => path.toVisitId === visitId && (includeFlights || path.mode !== "flight"));
}

export function dayMapVisits(data: DayMapData, includeFlights: boolean): MapVisit[] {
  if (includeFlights || !data.paths.some((path) => path.mode === "flight")) return data.visits;
  const ids = new Set(data.paths.filter((path) => path.mode !== "flight").flatMap((path) => [path.fromPlaceId, path.toPlaceId]));
  return ids.size ? data.visits.filter((visit) => ids.has(visit.place.id)) : data.visits;
}

/** Shared with the route cards so hotel stops don't shift the map's numbering. */
export function placeSequences(items: DayItem[], stayPlaceIds: Set<string>): number[] {
  let sequence = 0;
  return items.map((item) => {
    if (item.type !== "place" || stayPlaceIds.has(item.placeId)) return 0;
    return ++sequence;
  });
}

function pointOf(place: Place | undefined): MapPoint | undefined {
  const latitude = place?.latitude;
  const longitude = place?.longitude;
  if (latitude === undefined || longitude === undefined || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
  return [latitude, longitude];
}

/** Google's E5 encoding, also used by Wanderlog. Malformed geometry is not drawn. */
export function decodePolyline(encoded: string): MapPoint[] {
  const points: MapPoint[] = [];
  let cursor = 0;
  let latitude = 0;
  let longitude = 0;
  const delta = (): number | undefined => {
    let value = 0;
    for (let shift = 0; shift <= 30 && cursor < encoded.length; shift += 5) {
      const byte = encoded.charCodeAt(cursor++) - 63;
      if (byte < 0 || byte > 63) return;
      value += (byte & 31) * 2 ** shift;
      if (byte < 32) return value % 2 ? -(value + 1) / 2 : value / 2;
    }
  };
  while (cursor < encoded.length) {
    const lat = delta();
    const lng = delta();
    if (lat === undefined || lng === undefined) return [];
    latitude += lat;
    longitude += lng;
    if (Math.abs(latitude) > 9_000_000 || Math.abs(longitude) > 18_000_000) return [];
    points.push([latitude / 1e5, longitude / 1e5]);
  }
  return points;
}

export function buildDayMap(routing: DayRouting, bundle: Pick<TripBundle, "places">, stayPlaceIds: Set<string>): DayMapData {
  const stops = new Map<string, MapStop>();
  const missing = new Set<string>();
  const paths: MapPath[] = [];
  const visits: MapVisit[] = [];
  const addVisit = (id: string, placeId: string | undefined, label: string, time?: string) => {
    const place = placeId ? bundle.places[placeId] : undefined;
    const point = pointOf(place);
    if (place && point) visits.push({ id, place, point, label, time, kind: stopKind(place, stayPlaceIds) });
  };
  const addStop = (id: string | undefined, label: string, role: string) => {
    if (!id) return;
    const place = bundle.places[id];
    const point = pointOf(place);
    if (!place || !point) { missing.add(id); return; }
    const existing = stops.get(id);
    if (existing) {
      if (!existing.labels.includes(label)) existing.labels.push(label);
      if (!existing.roles.includes(role)) existing.roles.push(role);
    } else stops.set(id, { place, point, labels: [label], roles: [role] });
  };
  const addPath = (fromId: string | undefined, toId: string, leg: RouteLeg | undefined, fromVisitId: string | undefined, toVisitId: string | undefined, planKey: string) => {
    if (!fromId || fromId === toId) return;
    const from = pointOf(bundle.places[fromId]);
    const to = pointOf(bundle.places[toId]);
    if (!from || !to) return;
    const geometry = leg?.encodedPolyline ? decodePolyline(leg.encodedPolyline) : [];
    paths.push({
      fromPlaceId: fromId,
      toPlaceId: toId,
      fromVisitId,
      toVisitId,
      points: geometry.length >= 2 ? geometry : [from, to],
      mode: leg?.travelMode ?? "connection",
      approximate: geometry.length < 2,
      durationSeconds: leg?.durationSeconds,
      distanceMetres: leg?.distanceMetres,
      leg,
      planKey: leg ? planKey : undefined,
    });
  };
  const binding = bindFlights(routing.routeItems, routing.flights);
  const sequences = placeSequences(routing.routeItems, stayPlaceIds);
  let previous = routing.wokeInSlot?.stay.placeId;
  addStop(previous, "H", "Start hotel");
  addVisit("start", previous, "H");
  // The visit now standing at `placeId`, if it was mapped.
  const visitAt = (placeId: string | undefined) => { const last = visits.at(-1); return last && last.place.id === placeId ? last.id : undefined; };
  let previousVisit = visitAt(previous);
  for (const [index, item] of routing.routeItems.entries()) {
    if (item.type !== "place") continue;
    const hotel = stayPlaceIds.has(item.placeId);
    addStop(item.placeId, hotel ? "H" : String(sequences[index]), hotel ? "Hotel" : `Stop ${sequences[index]}`);
    // Wanderlog can also list a hotel as a stop immediately beside its bookend.
    if (visits.at(-1)?.place.id !== item.placeId) addVisit(item.id, item.placeId, hotel ? "H" : String(sequences[index]), item.startTime);
    const here = visitAt(item.placeId);
    if (!binding.supersededLegs.has(item.id)) addPath(previous, item.placeId, routing.legs.get(item.id), previousVisit, here, item.id);
    previous = item.placeId;
    previousVisit = here;
  }
  const end = routing.sleepsIn?.placeId;
  if (end) {
    addStop(end, "H", "End hotel");
    if (visits.at(-1)?.place.id !== end) addVisit("finish", end, "H");
    const lastItem = routing.routeItems.filter((item) => item.type === "place").at(-1);
    // A departure flight replaces the onward surface journey.
    if (!lastItem || !binding.after.has(lastItem.id)) addPath(previous, end, routing.endLeg, previousVisit, visitAt(end), "end");
  }
  for (const flight of routing.flights) {
    // Only flights represented in this day's route, including added airports.
    const from = flight.departPlaceId && stops.get(flight.departPlaceId);
    const to = flight.arrivePlaceId && stops.get(flight.arrivePlaceId);
    if (from && to) paths.push({
      fromPlaceId: from.place.id, toPlaceId: to.place.id,
      fromVisitId: visits.findLast((visit) => visit.place.id === from.place.id)?.id,
      toVisitId: visits.find((visit) => visit.place.id === to.place.id)?.id,
      points: [from.point, to.point], mode: "flight", approximate: true, durationSeconds: undefined, distanceMetres: undefined, leg: undefined, planKey: undefined,
    });
  }
  return { stops: [...stops.values()], visits, paths, missingPlaces: missing.size };
}
