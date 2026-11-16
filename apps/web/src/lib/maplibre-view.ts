/// <reference types="vite/client" />
import { AttributionControl, LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { MAP_MODES, dayMapPoints, dayMapVisits, legInto, type DayMapData, type DayMapView, type MapPoint } from "./day-map.js";
import { addPoiImages } from "./map-icons.js";
import { PALETTES, dayMapStyle, type MapTheme } from "./map-style.js";
import { mapPin, positionMapPin, updateMapPin } from "./map-pin.js";

/**
 * The Day map, drawn by MapLibre GL on the phone. The base map is our own
 * style (map-style.ts) over OpenFreeMap's vector tiles (OpenStreetMap data, no
 * key, no bill); the route lines, arrows and stops on top come from the stored trip.
 */

// Bundled, MapLibre would look for its worker beside our chunk; Vite emits it elsewhere.
setWorkerUrl(workerUrl);

const ROUTE_SOURCE = "journey-route";
const ARROW_IMAGE = "journey-arrow";
const lngLat = ([lat, lng]: MapPoint): [number, number] => [lng, lat];

function routeFeatures(data: DayMapData, theme: MapTheme) {
  return {
    type: "FeatureCollection" as const,
    features: data.paths.map((path, index) => ({
      type: "Feature" as const,
      id: index,
      properties: {
        colour: theme === "dark" ? MAP_MODES[path.mode].dark : MAP_MODES[path.mode].colour,
        style: path.mode === "flight" ? "flight" : path.mode === "walking" ? "walk" : path.approximate ? "approximate" : "solid",
      },
      geometry: { type: "LineString" as const, coordinates: path.points.map(lngLat) },
    })),
  };
}

/**
 * An arrowhead pointing along the line, as a signed-distance image so the
 * map paints it in each line's colour with an outline.
 */
function arrowImage(): ImageData {
  const size = 40;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(size, size);
  context.fillStyle = "#000";
  context.beginPath();
  context.moveTo(11, 9);
  context.lineTo(30, 20);
  context.lineTo(11, 31);
  context.lineTo(16, 20);
  context.closePath();
  context.fill();
  return context.getImageData(0, 0, size, size);
}

const width = (low: number, high: number) => ["interpolate", ["linear"], ["zoom"], 9, low, 16, high];
/** Legs other than the one being stepped to fade back. */
const dimmed = (opacity: number, faded: number) => ["case", ["boolean", ["feature-state", "dim"], false], faded, opacity];

function addRoute(map: MapLibreMap, data: DayMapData, theme: MapTheme, flightsVisible: boolean): void {
  const casing = PALETTES[theme].routeCasing;
  if (!map.hasImage(ARROW_IMAGE)) map.addImage(ARROW_IMAGE, arrowImage(), { pixelRatio: 2, sdf: true });
  if (!map.getSource(ROUTE_SOURCE)) map.addSource(ROUTE_SOURCE, { type: "geojson", data: routeFeatures(data, theme) });
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const layers = [
    // A casing keeps a line distinct from the streets and railways beneath it.
    { id: "journey-casing", type: "line", filter: ["match", ["get", "style"], ["solid", "approximate"], true, false], layout: round,
      paint: { "line-color": casing, "line-width": width(5, 10), "line-opacity": dimmed(0.95, 0.3) } },
    { id: "journey-solid", type: "line", filter: ["==", ["get", "style"], "solid"], layout: round,
      paint: { "line-color": ["get", "colour"], "line-width": width(3, 6), "line-opacity": dimmed(1, 0.35) } },
    { id: "journey-approximate", type: "line", filter: ["==", ["get", "style"], "approximate"], layout: { "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": width(2.5, 4.5), "line-dasharray": [2, 1.5], "line-opacity": dimmed(0.85, 0.3) } },
    // Walks as dots: a round cap on a zero-length dash.
    { id: "journey-walk", type: "line", filter: ["==", ["get", "style"], "walk"], layout: round,
      paint: { "line-color": ["get", "colour"], "line-width": width(3.5, 6), "line-dasharray": [0, 1.6], "line-opacity": dimmed(1, 0.35) } },
    { id: "journey-flight", type: "line", filter: ["==", ["get", "style"], "flight"],
      layout: { ...round, visibility: flightsVisible ? "visible" : "none" },
      paint: { "line-color": ["get", "colour"], "line-width": 2.5, "line-dasharray": [1.5, 2], "line-opacity": dimmed(0.9, 0.3) } },
    { id: "journey-arrows", type: "symbol", filter: ["==", ["get", "style"], "solid"],
      layout: { "symbol-placement": "line", "symbol-spacing": 120, "icon-image": ARROW_IMAGE, "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.75, 16, 1], "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["get", "colour"], "icon-halo-color": casing, "icon-halo-width": 2, "icon-opacity": dimmed(1, 0.3) } },
  ];
  for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer({ ...layer, source: ROUTE_SOURCE } as Parameters<MapLibreMap["addLayer"]>[0]);
}

type PinEntry = { marker: Marker; wrapper: HTMLElement; node: HTMLElement; stop: DayMapData["stops"][number]; shown: boolean };
type Padding = { top: number; bottom: number; left: number; right: number };

export async function mountMapLibreDayMap(
  element: HTMLElement,
  data: DayMapData,
  initialTheme: MapTheme,
  select: (visitId: string) => void,
  unavailable: (failed: boolean) => void,
  signal: AbortSignal,
): Promise<DayMapView> {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const duration = (ms: number) => (reducedMotion ? 0 : ms);
  let theme = initialTheme;
  let wholeScope = false;
  let activeLeg: number | undefined;

  /** What floats over the map (scope switch, step card, buttons) marks itself with data-map-overlay. */
  const overlays = () => [...(element.parentElement?.querySelectorAll<HTMLElement>("[data-map-overlay]") ?? [])];
  const padding = (): Padding => {
    const box = element.getBoundingClientRect();
    // Captions stand above their pins; the zoom buttons and attribution sit at the top right.
    const next = { top: 64, bottom: 28, left: 36, right: 56 };
    for (const overlay of overlays()) {
      const rect = overlay.getBoundingClientRect();
      if (!rect.height) continue;
      // Room for a pin's caption (about 80px tall above its point) under the top overlays.
      if (overlay.dataset.mapOverlay === "top") next.top = Math.max(next.top, rect.bottom - box.top + 88);
      else next.bottom = Math.max(next.bottom, box.bottom - rect.top + 20);
    }
    // A short map still has to show something: give back padding until 40% of it is free.
    const spare = box.height * 0.6;
    if (next.top + next.bottom > spare) {
      const scale = spare / (next.top + next.bottom);
      next.top = Math.round(next.top * scale);
      next.bottom = Math.round(next.bottom * scale);
    }
    return next;
  };

  const bounds = (points: MapPoint[]) => {
    const box = new LngLatBounds();
    for (const point of points) box.extend(lngLat(point));
    return box;
  };
  const initial = bounds(dayMapPoints(data, false));
  const map = new MapLibreMap({
    container: element,
    style: dayMapStyle(theme),
    ...(initial.isEmpty() ? { center: [139.76, 35.68] as [number, number], zoom: 11 } : { bounds: initial, fitBoundsOptions: { padding: padding(), maxZoom: 16 } }),
    attributionControl: false,
    // In a scrolling page, one finger scrolls the page; two move the map. Map mode turns this off.
    cooperativeGestures: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    renderWorldCopies: false,
    fadeDuration: reducedMotion ? 0 : 150,
  });
  if (import.meta.env.DEV) (window as unknown as { dayMap?: MapLibreMap }).dayMap = map;
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // Top right, out of the way of the step card docked over the map's foot.
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new AttributionControl({ compact: true }), "top-right");

  const applyLegState = () => {
    if (!map.getSource(ROUTE_SOURCE)) return;
    data.paths.forEach((_, index) => map.setFeatureState({ source: ROUTE_SOURCE, id: index }, { dim: activeLeg !== undefined && index !== activeLeg }));
  };
  map.on("style.load", () => {
    addPoiImages(map, theme);
    addRoute(map, data, theme, wholeScope);
    applyLegState();
  });
  // Tiles that fail (offline, or OpenFreeMap down) leave the route and stops drawn on the plain ground.
  let tileErrors = false;
  map.on("error", () => { tileErrors = true; });
  map.on("idle", () => { unavailable(tileErrors); tileErrors = false; });

  const entries: PinEntry[] = [];
  const first = dayMapVisits(data, false)[0];
  for (const stop of data.stops) {
    const node = mapPin(stop, data);
    const wrapper = document.createElement("div");
    wrapper.className = "day-map__pin";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.dataset.haptic = "selection";
    wrapper.setAttribute("aria-label", `${stop.roles.join(" · ")}: ${stop.place.name}`);
    wrapper.append(node);
    const choose = (event: Event) => {
      event.stopPropagation();
      const visits = dayMapVisits(data, wholeScope).filter((item) => item.place.id === stop.place.id);
      // A place visited twice: tapping it again moves to its next visit.
      const current = visits.findIndex((item) => item.id === selectedVisit);
      const visit = visits[(current + 1) % visits.length];
      if (visit) select(visit.id);
    };
    wrapper.addEventListener("click", choose);
    wrapper.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(event); } });
    const marker = new Marker({ element: wrapper, anchor: "center" }).setLngLat(lngLat(stop.point)).addTo(map);
    entries.push({ marker, wrapper, node, stop, shown: true });
  }

  let selectedVisit = first?.id;
  let selectedPlace = first?.place.id;
  const priority = (entry: PinEntry) => {
    if (entry.stop.place.id === selectedPlace) return 1000;
    const phase = entry.node.dataset.phase;
    if (phase && phase !== "stop") return 100;
    return entry.node.dataset.kind === "poi" ? 60 : 10;
  };

  /**
   * Edge-aware captions. A stop whose badge lands on a more important badge
   * shrinks to a dot, and captions that would cover a more important pin or
   * anything floating over the map are hidden: the selected stop wins, then
   * Start and Finish, then points of interest.
   */
  function declutter() {
    const box = element.getBoundingClientRect();
    const order = entries.filter((entry) => entry.shown).sort((a, b) => priority(b) - priority(a));
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const badges: DOMRect[] = [];
    for (const entry of order) {
      entry.wrapper.style.zIndex = String(priority(entry));
      positionMapPin(entry.node, map.project(lngLat(entry.stop.point)).x, element.clientWidth);
      entry.node.classList.remove("journey-pin--quiet", "journey-pin--dot");
      const badge = entry.node.querySelector(".journey-pin__badge")?.getBoundingClientRect();
      if (!badge) continue;
      if (priority(entry) < 100 && badges.some((other) => overlaps(badge, other))) entry.node.classList.add("journey-pin--dot", "journey-pin--quiet");
      else badges.push(badge);
    }
    const taken = [...badges, ...overlays().map((overlay) => overlay.getBoundingClientRect())];
    for (const entry of order) {
      if (entry.node.classList.contains("journey-pin--dot")) continue;
      const caption = entry.node.querySelector<HTMLElement>(".journey-pin__caption");
      if (!caption || getComputedStyle(caption).display === "none") continue;
      const rect = caption.getBoundingClientRect();
      const offMap = rect.left < box.left || rect.right > box.right || rect.top < box.top;
      if (priority(entry) < 1000 && (offMap || taken.some((other) => overlaps(rect, other)))) entry.node.classList.add("journey-pin--quiet");
      else taken.push(rect);
    }
  }
  map.on("moveend", declutter);

  function highlight(visitId: string) {
    const visit = data.visits.find((item) => item.id === visitId);
    selectedVisit = visit?.id;
    selectedPlace = visit?.place.id;
    for (const entry of entries) entry.node.classList.toggle("journey-pin--selected", entry.stop.place.id === selectedPlace);
    declutter();
  }

  const fit = (includeFlights = false) => {
    wholeScope = includeFlights;
    activeLeg = undefined;
    applyLegState();
    if (map.getLayer("journey-flight")) map.setLayoutProperty("journey-flight", "visibility", includeFlights ? "visible" : "none");
    const ids = new Set(dayMapVisits(data, includeFlights).map((visit) => visit.place.id));
    for (const entry of entries) {
      updateMapPin(entry.node, entry.stop, data, includeFlights);
      const show = ids.has(entry.stop.place.id);
      if (show && !entry.shown) entry.marker.addTo(map);
      if (!show && entry.shown) entry.marker.remove();
      entry.shown = show;
    }
    const box = bounds(dayMapPoints(data, includeFlights));
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    if (!box.isEmpty()) map.fitBounds(box, { padding: padding(), maxZoom: 16, duration: duration(450) });
    declutter();
  };

  await new Promise<void>((resolve, reject) => {
    if (map.loaded()) { resolve(); return; }
    map.once("load", () => resolve());
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }).catch((error: unknown) => { map.remove(); throw error; });
  if (first) highlight(first.id);
  // MapLibre opens the compact attribution until the first interaction; start it folded, over less of the map.
  element.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show");

  const observer = new ResizeObserver(() => map.resize());
  observer.observe(element);
  return {
    fit,
    highlight,
    focusLeg(visitId) {
      const visit = data.visits.find((item) => item.id === visitId);
      if (!visit) return;
      highlight(visitId);
      const leg = legInto(data, visitId, wholeScope);
      activeLeg = leg ? data.paths.indexOf(leg) : undefined;
      applyLegState();
      // Frame the way in: where you came from, the line, and where you arrive.
      const box = bounds(leg ? [...leg.points, visit.point] : [visit.point]);
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
      map.fitBounds(box, { padding: padding(), maxZoom: visit.kind === "airport" ? 13 : 16.5, duration: duration(600) });
    },
    focusStop(visitId) {
      const visit = data.visits.find((item) => item.id === visitId);
      if (!visit) return;
      highlight(visitId);
      activeLeg = undefined;
      applyLegState();
      // Close enough to see what is around the stop: its streets, stations and food.
      const zoom = visit.kind === "airport" ? 13 : Math.max(map.getZoom(), 15.5);
      // Centred in the space the overlays leave, by offset: `padding` here would stay on the
      // map and be counted again by every later fitBounds, which then can't fit and does nothing.
      const room = padding();
      map.easeTo({ center: lngLat(visit.point), zoom, offset: [(room.left - room.right) / 2, (room.top - room.bottom) / 2], duration: duration(600) });
    },
    setTheme(next) {
      if (next === theme) return;
      theme = next;
      // A full swap: the source and route layers are re-added on style.load in the new colours.
      map.setStyle(dayMapStyle(theme), { diff: false });
    },
    setInteractive(on) {
      if (on) map.cooperativeGestures.disable();
      else map.cooperativeGestures.enable();
    },
    retry() {
      tileErrors = false;
      map.setStyle(dayMapStyle(theme), { diff: false });
    },
    destroy() {
      observer.disconnect();
      map.remove();
    },
  };
}
