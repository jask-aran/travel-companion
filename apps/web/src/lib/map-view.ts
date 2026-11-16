import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_MODES, dayMapPoints, dayMapVisits, type DayMapData, type DayMapView } from "./day-map.js";
import { mapPin, updateMapPin, positionMapPin } from "./map-pin.js";

export function mountDayMap(element: HTMLElement, data: DayMapData, tilesUnavailable: (unavailable: boolean) => void, select: (id: string) => void): DayMapView {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const map = L.map(element, {
    scrollWheelZoom: false,
    zoomSnap: 0.25,
    zoomAnimation: !reducedMotion,
    fadeAnimation: !reducedMotion,
    markerZoomAnimation: !reducedMotion,
  });
  const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  });
  tiles.on("tileerror", () => tilesUnavailable(true));
  tiles.on("tileload", () => tilesUnavailable(false));
  tiles.addTo(map);
  map.attributionControl.setPrefix(false);

  let wholeScope = false;
  const flightLines: L.Polyline[] = [];
  for (const path of data.paths) {
    const mode = MAP_MODES[path.mode];
    const options = { weight: 4, opacity: 0.9, ...(path.approximate ? { dashArray: "5 7" } : {}) };
    const casing = L.polyline(path.points, { ...options, weight: 7, color: "#fff", opacity: 0.8, interactive: false }).addTo(map);
    const label = document.createElement("span");
    label.textContent = path.mode === "flight" ? "Flight · schematic connection" : `${mode.label}${path.approximate ? " · approximate connection" : ""}`;
    const line = L.polyline(path.points, { ...options, color: mode.colour }).bindPopup(label).addTo(map);
    if (path.mode === "flight") flightLines.push(casing, line);
  }
  const markers: { marker: L.Marker; node: HTMLElement; stop: DayMapData["stops"][number] }[] = [];
  for (const stop of data.stops) {
    const icon = mapPin(stop, data);
    const marker = L.marker(stop.point, {
      icon: L.divIcon({ html: icon, className: "day-map__marker", iconSize: [38, 44], iconAnchor: [19, 44] }),
      title: `${stop.roles.join(" · ")}: ${stop.place.name}`,
      alt: stop.place.name,
      keyboard: true,
      riseOnHover: true,
    });
    marker.on("add", () => marker.getElement()?.setAttribute("aria-label", `${stop.roles.join(" · ")}: ${stop.place.name}`));
    marker.on("click", () => {
      const visit = dayMapVisits(data, wholeScope).find((item) => item.place.id === stop.place.id);
      if (visit) { select(visit.id); highlight(visit.id); }
    });
    marker.addTo(map);
    markers.push({ marker, node: icon, stop });
  }
  function highlight(visitId: string) {
    const visit = data.visits.find((item) => item.id === visitId);
    for (const entry of markers) {
      const selected = visit?.place.id === entry.stop.place.id;
      entry.node.classList.toggle("journey-pin--selected", selected);
      entry.marker.setZIndexOffset(selected ? 1000 : 0);
    }
  }
  const positionLabels = () => {
    for (const { marker, node } of markers) positionMapPin(node, map.latLngToContainerPoint(marker.getLatLng()).x, map.getSize().x);
  };
  map.on("moveend zoomend resize", positionLabels);
  const fit = (includeFlights = false) => {
    wholeScope = includeFlights;
    const ids = new Set(dayMapVisits(data, includeFlights).map((visit) => visit.place.id));
    for (const line of flightLines) { if (includeFlights) line.addTo(map); else line.remove(); }
    for (const entry of markers) {
      updateMapPin(entry.node, entry.stop, data, includeFlights);
      if (ids.has(entry.stop.place.id)) entry.marker.addTo(map); else entry.marker.remove();
    }
    const bounds = L.latLngBounds(dayMapPoints(data, includeFlights));
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16, animate: false });
  };
  fit();
  const first = dayMapVisits(data, false)[0];
  if (first) highlight(first.id);
  const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  observer.observe(element);
  return {
    fit,
    highlight,
    focus(visitId) {
      const visit = data.visits.find((item) => item.id === visitId);
      if (!visit) return;
      highlight(visitId);
      map.setView(visit.point, Math.max(map.getZoom(), visit.kind === "airport" ? 12 : 15), { animate: !reducedMotion });
    },
    retry: () => tiles.redraw(),
    destroy() { observer.disconnect(); map.remove(); },
  };
}
