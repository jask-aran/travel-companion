import type { DayItem, Place, RouteLeg, TripBundle } from "@travel-companion/trip-schema";
import type { DayRouting } from "./day-routing.js";
import { bindFlights } from "./flight-binding.js";

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
  points: MapPoint[];
  mode: RouteLeg["travelMode"] | "connection";
  approximate: boolean;
};
export const MAP_MODES: Record<MapPath["mode"], { label: string; colour: string }> = {
  walking: { label: "Walk", colour: "#267969" },
  transit: { label: "Transit", colour: "#246caa" },
  driving: { label: "Drive", colour: "#9a6018" },
  cycling: { label: "Cycle", colour: "#267969" },
  ferry: { label: "Ferry", colour: "#246caa" },
  flight: { label: "Flight", colour: "#8550a1" },
  connection: { label: "Connection", colour: "#697582" },
};
export type DayMapData = { stops: MapStop[]; visits: MapVisit[]; paths: MapPath[]; missingPlaces: number };
export type DayMapView = {
  fit(includeFlights?: boolean): void;
  focus(visitId: string): void;
  highlight(visitId: string): void;
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
  const addPath = (fromId: string | undefined, toId: string, leg: RouteLeg | undefined) => {
    if (!fromId || fromId === toId) return;
    const from = pointOf(bundle.places[fromId]);
    const to = pointOf(bundle.places[toId]);
    if (!from || !to) return;
    const geometry = leg?.encodedPolyline ? decodePolyline(leg.encodedPolyline) : [];
    paths.push({
      fromPlaceId: fromId,
      toPlaceId: toId,
      points: geometry.length >= 2 ? geometry : [from, to],
      mode: leg?.travelMode ?? "connection",
      approximate: geometry.length < 2,
    });
  };
  const binding = bindFlights(routing.routeItems, routing.flights);
  const sequences = placeSequences(routing.routeItems, stayPlaceIds);
  let previous = routing.wokeInSlot?.stay.placeId;
  addStop(previous, "H", "Start hotel");
  addVisit("start", previous, "H");
  for (const [index, item] of routing.routeItems.entries()) {
    if (item.type !== "place") continue;
    const hotel = stayPlaceIds.has(item.placeId);
    addStop(item.placeId, hotel ? "H" : String(sequences[index]), hotel ? "Hotel" : `Stop ${sequences[index]}`);
    // Wanderlog can also list a hotel as a stop immediately beside its bookend.
    if (visits.at(-1)?.place.id !== item.placeId) addVisit(item.id, item.placeId, hotel ? "H" : String(sequences[index]), item.startTime);
    if (!binding.supersededLegs.has(item.id)) addPath(previous, item.placeId, routing.legs.get(item.id));
    previous = item.placeId;
  }
  const end = routing.sleepsIn?.placeId;
  if (end) {
    addStop(end, "H", "End hotel");
    if (visits.at(-1)?.place.id !== end) addVisit("finish", end, "H");
    const lastItem = routing.routeItems.filter((item) => item.type === "place").at(-1);
    // A departure flight replaces the onward surface journey.
    if (!lastItem || !binding.after.has(lastItem.id)) addPath(previous, end, routing.endLeg);
  }
  for (const flight of routing.flights) {
    // Only flights represented in this day's route, including added airports.
    const from = flight.departPlaceId && stops.get(flight.departPlaceId);
    const to = flight.arrivePlaceId && stops.get(flight.arrivePlaceId);
    if (from && to) paths.push({ fromPlaceId: from.place.id, toPlaceId: to.place.id, points: [from.point, to.point], mode: "flight", approximate: true });
  }
  return { stops: [...stops.values()], visits, paths, missingPlaces: missing.size };
}
