import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { MAP_MODES, type DayMapData } from "./day-map.js";
import { buildGoogleMapsUrl } from "./maps.js";

export function mountDayMap(element: HTMLElement, data: DayMapData, tilesUnavailable: (unavailable: boolean) => void) {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const map = L.map(element, {
    scrollWheelZoom: false,
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

  for (const path of data.paths) {
    const mode = MAP_MODES[path.mode];
    const options = { weight: 4, opacity: 0.9, ...(path.approximate ? { dashArray: "5 7" } : {}) };
    L.polyline(path.points, { ...options, weight: 7, color: "#fff", opacity: 0.8, interactive: false }).addTo(map);
    const label = document.createElement("span");
    label.textContent = path.mode === "flight" ? "Flight · schematic connection" : `${mode.label}${path.approximate ? " · approximate connection" : ""}`;
    L.polyline(path.points, { ...options, color: mode.colour }).bindPopup(label).addTo(map);
  }
  for (const stop of data.stops) {
    const icon = document.createElement("span");
    icon.className = `day-map__pin${stop.labels.includes("H") ? " day-map__pin--hotel" : ""}`;
    icon.textContent = stop.labels.join("·");
    const popup = document.createElement("div");
    popup.className = "day-map__popup";
    const title = document.createElement("strong");
    title.textContent = stop.place.name;
    const detail = document.createElement("p");
    detail.textContent = stop.roles.join(" · ");
    const directions = document.createElement("a");
    directions.textContent = "Directions";
    directions.href = buildGoogleMapsUrl(stop.place);
    directions.target = "_blank";
    directions.rel = "noopener noreferrer";
    popup.append(title, detail, directions);
    const marker = L.marker(stop.point, {
      icon: L.divIcon({ html: icon, className: "day-map__marker", iconSize: [34, 34], iconAnchor: [17, 17] }),
      title: `${stop.roles.join(" · ")}: ${stop.place.name}`,
      alt: stop.place.name,
      keyboard: true,
      riseOnHover: true,
    }).bindPopup(popup);
    marker.on("add", () => marker.getElement()?.setAttribute("aria-label", `${stop.roles.join(" · ")}: ${stop.place.name}`));
    marker.addTo(map);
  }
  const bounds = L.latLngBounds(data.stops.map((stop) => stop.point));
  for (const path of data.paths) for (const point of path.points) bounds.extend(point);
  const fit = () => {
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16, animate: false });
  };
  fit();
  const observer = new ResizeObserver(() => map.invalidateSize({ pan: false }));
  observer.observe(element);
  return {
    fit,
    retryTiles: () => tiles.redraw(),
    destroy() { observer.disconnect(); map.remove(); },
  };
}
