/// <reference types="google.maps" />
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { MAP_MODES, dayMapPoints, dayMapVisits, type DayMapData, type DayMapView, type MapPoint } from "./day-map.js";
import { googleMapId, googleMapsKey } from "./google-map-config.js";
import { mapPin, updateMapPin, positionMapPin } from "./map-pin.js";

declare global {
  interface Window { gm_authFailure?: () => void }
}
let loading: Promise<[google.maps.MapsLibrary, google.maps.MarkerLibrary]> | undefined;
let authenticationFailed = false;
let configured = false;
const authListeners = new Set<() => void>();
function libraries() {
  if (!googleMapsKey) return Promise.reject(new Error("Google Maps browser key is not configured."));
  if (!configured) {
    configured = true;
    const previous = window.gm_authFailure;
    window.gm_authFailure = () => {
      authenticationFailed = true;
      previous?.();
      for (const listener of authListeners) listener();
    };
    setOptions({ key: googleMapsKey, v: "weekly", language: "en" });
  }
  loading ??= Promise.all([importLibrary("maps"), importLibrary("marker")]).catch((error: unknown) => { loading = undefined; throw error; });
  return loading;
}
const latLng = ([lat, lng]: MapPoint): google.maps.LatLngLiteral => ({ lat, lng });

export async function mountGoogleDayMap(
  element: HTMLElement,
  data: DayMapData,
  select: (visitId: string) => void,
  unavailable: (failed: boolean) => void,
  signal: AbortSignal,
): Promise<DayMapView> {
  const [{ Map: GoogleMap, Polyline }, { AdvancedMarkerElement }] = await libraries();
  signal.throwIfAborted();
  if (authenticationFailed) throw new Error("Google Maps authentication failed.");
  const map = new GoogleMap(element, {
    mapId: googleMapId,
    center: latLng(data.visits[0]?.point ?? [35.68, 139.76]),
    zoom: 12,
    isFractionalZoomEnabled: true,
    colorScheme: google.maps.ColorScheme.LIGHT,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: false,
    cameraControl: false,
    zoomControl: true,
    zoomControlOptions: { position: google.maps.ControlPosition.RIGHT_BOTTOM },
    gestureHandling: "cooperative",
    clickableIcons: true,
    tilt: 0,
  });
  const onAuthFailure = () => unavailable(true);
  authListeners.add(onAuthFailure);
  const lines: google.maps.Polyline[] = [];
  const flights: google.maps.Polyline[] = [];
  let wholeScope = false;
  for (const path of data.paths) {
    const colour = MAP_MODES[path.mode].colour;
    const options: google.maps.PolylineOptions = {
      path: path.points.map(latLng), map, geodesic: path.mode === "flight", clickable: false,
      strokeColor: colour, strokeWeight: path.mode === "flight" ? 3 : 5, strokeOpacity: 0.95,
      zIndex: path.mode === "flight" ? 1 : 3,
    };
    if (path.approximate || path.mode === "walking") {
      options.strokeOpacity = 0;
      options.icons = [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.95, strokeColor: colour, scale: 2 }, offset: "0", repeat: path.mode === "flight" ? "18px" : "10px" }];
    } else {
      // A pale casing keeps the route distinct from Google's roads and railway lines.
      lines.push(new Polyline({ ...options, strokeColor: "#fff", strokeWeight: 9, strokeOpacity: 0.9, zIndex: 2 }));
      options.icons = [{ icon: { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 2, strokeWeight: 1, fillOpacity: 1 }, offset: "55%" }];
    }
    const line = new Polyline(options);
    lines.push(line);
    if (path.mode === "flight") flights.push(line);
  }
  const markers: { marker: google.maps.marker.AdvancedMarkerElement; node: HTMLElement; stop: DayMapData["stops"][number] }[] = [];
  const first = dayMapVisits(data, false)[0];
  const last = dayMapVisits(data, false).at(-1);
  for (const stop of data.stops) {
    const endpoint = stop.place.id === first?.place.id || stop.place.id === last?.place.id;
    const node = mapPin(stop, data);
    const marker = new AdvancedMarkerElement({
      map, position: latLng(stop.point), title: `${stop.roles.join(" · ")}: ${stop.place.name}`,
      gmpClickable: true,
      collisionBehavior: endpoint ? "REQUIRED_AND_HIDES_OPTIONAL" : "OPTIONAL_AND_HIDES_LOWER_PRIORITY",
      zIndex: endpoint ? 100 : node.dataset.kind === "poi" ? 60 : 10,
    });
    marker.append(node);
    marker.addListener("click", () => {
      const visit = dayMapVisits(data, wholeScope).find((item) => item.place.id === stop.place.id);
      if (visit) { select(visit.id); highlight(visit.id); }
    });
    markers.push({ marker, node, stop });
  }
  function highlight(visitId: string) {
    const visit = data.visits.find((item) => item.id === visitId);
    const scoped = dayMapVisits(data, wholeScope);
    for (const entry of markers) {
      const selected = entry.stop.place.id === visit?.place.id;
      const endpoint = entry.stop.place.id === scoped[0]?.place.id || entry.stop.place.id === scoped.at(-1)?.place.id;
      entry.node.classList.toggle("journey-pin--selected", selected);
      entry.marker.collisionBehavior = selected || endpoint ? "REQUIRED_AND_HIDES_OPTIONAL" : "OPTIONAL_AND_HIDES_LOWER_PRIORITY";
      entry.marker.zIndex = selected ? 1000 : endpoint ? 100 : entry.node.dataset.kind === "poi" ? 60 : 10;
    }
  }
  map.addListener("idle", () => {
    const bounds = map.getBounds()?.toJSON();
    if (!bounds) return;
    const span = (bounds.east - bounds.west + 360) % 360 || 360;
    for (const { stop, node } of markers) {
      const fraction = ((stop.point[1] - bounds.west + 360) % 360) / span;
      positionMapPin(node, fraction * element.clientWidth, element.clientWidth);
    }
  });
  const fit = (includeFlights = false) => {
    wholeScope = includeFlights;
    const ids = new Set(dayMapVisits(data, includeFlights).map((visit) => visit.place.id));
    for (const line of flights) line.setVisible(includeFlights);
    for (const entry of markers) {
      updateMapPin(entry.node, entry.stop, data, includeFlights);
      entry.marker.map = ids.has(entry.stop.place.id) ? map : null;
    }
    const bounds = new google.maps.LatLngBounds();
    for (const point of dayMapPoints(data, includeFlights)) bounds.extend(latLng(point));
    if (bounds.isEmpty()) return;
    map.fitBounds(bounds, { top: 52, bottom: 42, left: 48, right: 48 });
    google.maps.event.addListenerOnce(map, "idle", () => { if ((map.getZoom() ?? 0) > 16) map.setZoom(16); });
  };
  fit();
  if (first) highlight(first.id);
  const observer = new ResizeObserver(() => google.maps.event.trigger(map, "resize"));
  observer.observe(element);
  return {
    fit,
    highlight,
    focus(visitId) {
      const visit = data.visits.find((item) => item.id === visitId);
      if (!visit) return;
      highlight(visitId);
      map.panTo(latLng(visit.point));
      map.setZoom(Math.max(map.getZoom() ?? 0, visit.kind === "airport" ? 12 : 15));
    },
    retry: () => location.reload(),
    destroy() {
      observer.disconnect();
      authListeners.delete(onAuthFailure);
      for (const line of lines) line.setMap(null);
      for (const { marker } of markers) { google.maps.event.clearInstanceListeners(marker); marker.map = null; }
      google.maps.event.clearInstanceListeners(map);
      map.unbindAll();
      element.replaceChildren();
    },
  };
}
