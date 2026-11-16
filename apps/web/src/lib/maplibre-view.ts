/// <reference types="vite/client" />
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { MAP_MODES, dayMapPoints, dayMapVisits, type DayMapData, type DayMapView, type MapPoint } from "./day-map.js";
import { mapPin, positionMapPin, updateMapPin } from "./map-pin.js";

/**
 * The Day map, drawn by MapLibre GL on the phone. The base map is
 * OpenFreeMap's Liberty style as published (OpenStreetMap data, no key, no
 * bill); the route lines, arrows and stops on top are ours, from the stored trip.
 */
const BASE_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
type MapStyle = Exclude<Parameters<MapLibreMap["setStyle"]>[0], string | null | undefined>;

let styleRequest: Promise<MapStyle> | undefined;
/** Fetched once per page, so a failure (offline) can fall back to a blank base. */
function loadBaseStyle(): Promise<MapStyle> {
  styleRequest ??= fetch(BASE_STYLE_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`Map style answered ${response.status}`);
      return response.json() as Promise<MapStyle>;
    })
    .catch((error: unknown) => { styleRequest = undefined; throw error; });
  return styleRequest;
}

// Bundled, MapLibre would look for its worker beside our chunk; Vite emits it elsewhere.
setWorkerUrl(workerUrl);

const ROUTE_SOURCE = "journey-route";
const ARROW_IMAGE = "journey-arrow";
const lngLat = ([lat, lng]: MapPoint): [number, number] => [lng, lat];

/** Only our own layers: what the map shows when the base map can't be fetched. */
const BLANK_STYLE: MapStyle = { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#f1ece1" } }] };

function routeFeatures(data: DayMapData) {
  return {
    type: "FeatureCollection" as const,
    features: data.paths.map((path, index) => ({
      type: "Feature" as const,
      id: index,
      properties: {
        colour: MAP_MODES[path.mode].colour,
        style: path.mode === "flight" ? "flight" : path.mode === "walking" ? "walk" : path.approximate ? "approximate" : "solid",
      },
      geometry: { type: "LineString" as const, coordinates: path.points.map(lngLat) },
    })),
  };
}

/**
 * An arrowhead pointing along the line, as a signed-distance image so the
 * map paints it in each line's colour with a paper outline.
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

function addRoute(map: MapLibreMap, data: DayMapData, flightsVisible: boolean): void {
  if (!map.hasImage(ARROW_IMAGE)) map.addImage(ARROW_IMAGE, arrowImage(), { pixelRatio: 2, sdf: true });
  if (!map.getSource(ROUTE_SOURCE)) map.addSource(ROUTE_SOURCE, { type: "geojson", data: routeFeatures(data) });
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const layers = [
    // A pale casing keeps a line distinct from the streets and railways beneath it.
    { id: "journey-casing", type: "line", filter: ["match", ["get", "style"], ["solid", "approximate"], true, false], layout: round,
      paint: { "line-color": "#fffdf8", "line-width": width(5, 10), "line-opacity": 0.95 } },
    { id: "journey-solid", type: "line", filter: ["==", ["get", "style"], "solid"], layout: round,
      paint: { "line-color": ["get", "colour"], "line-width": width(3, 6) } },
    { id: "journey-approximate", type: "line", filter: ["==", ["get", "style"], "approximate"], layout: { "line-join": "round" },
      paint: { "line-color": ["get", "colour"], "line-width": width(2.5, 4.5), "line-dasharray": [2, 1.5], "line-opacity": 0.85 } },
    // Walks as dots: a round cap on a zero-length dash.
    { id: "journey-walk", type: "line", filter: ["==", ["get", "style"], "walk"], layout: round,
      paint: { "line-color": ["get", "colour"], "line-width": width(3.5, 6), "line-dasharray": [0, 1.6] } },
    { id: "journey-flight", type: "line", filter: ["==", ["get", "style"], "flight"],
      layout: { ...round, visibility: flightsVisible ? "visible" : "none" },
      paint: { "line-color": ["get", "colour"], "line-width": 2.5, "line-dasharray": [1.5, 2], "line-opacity": 0.9 } },
    { id: "journey-arrows", type: "symbol", filter: ["==", ["get", "style"], "solid"],
      layout: { "symbol-placement": "line", "symbol-spacing": 120, "icon-image": ARROW_IMAGE, "icon-size": ["interpolate", ["linear"], ["zoom"], 6, 0.75, 16, 1], "icon-allow-overlap": true, "icon-ignore-placement": true },
      paint: { "icon-color": ["get", "colour"], "icon-halo-color": "#fffdf8", "icon-halo-width": 2 } },
  ];
  for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer({ ...layer, source: ROUTE_SOURCE } as Parameters<MapLibreMap["addLayer"]>[0]);
}

type PinEntry = { marker: Marker; wrapper: HTMLElement; node: HTMLElement; stop: DayMapData["stops"][number]; shown: boolean };

export async function mountMapLibreDayMap(
  element: HTMLElement,
  data: DayMapData,
  select: (visitId: string) => void,
  unavailable: (failed: boolean) => void,
  signal: AbortSignal,
): Promise<DayMapView> {
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let style: MapStyle;
  let baseMissing = false;
  try {
    style = await loadBaseStyle();
  } catch {
    style = BLANK_STYLE;
    baseMissing = true;
  }
  signal.throwIfAborted();
  unavailable(baseMissing);

  const bounds = (includeFlights: boolean) => {
    const box = new LngLatBounds();
    for (const point of dayMapPoints(data, includeFlights)) box.extend(lngLat(point));
    return box;
  };
  // Captions stand above their pins, and the zoom buttons sit bottom right.
  const padding = { top: 110, bottom: 48, left: 48, right: 64 };
  const initial = bounds(false);
  const map = new MapLibreMap({
    container: element,
    style,
    ...(initial.isEmpty() ? { center: [139.76, 35.68] as [number, number], zoom: 11 } : { bounds: initial, fitBoundsOptions: { padding, maxZoom: 16 } }),
    attributionControl: { compact: true },
    // In a scrolling page, one finger scrolls the page; two move the map.
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
  map.addControl(new NavigationControl({ showCompass: false }), "bottom-right");

  let wholeScope = false;
  map.on("style.load", () => addRoute(map, data, wholeScope));
  // Tiles that fail (offline, or OpenFreeMap down) leave the route and stops drawn on paper.
  let tileErrors = false;
  map.on("error", () => { tileErrors = true; });
  map.on("idle", () => { unavailable(baseMissing || tileErrors); tileErrors = false; });

  const entries: PinEntry[] = [];
  const first = dayMapVisits(data, false)[0];
  for (const stop of data.stops) {
    const node = mapPin(stop, data);
    const wrapper = document.createElement("div");
    wrapper.className = "day-map__pin";
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", `${stop.roles.join(" · ")}: ${stop.place.name}`);
    wrapper.append(node);
    const choose = (event: Event) => {
      event.stopPropagation();
      const visit = dayMapVisits(data, wholeScope).find((item) => item.place.id === stop.place.id);
      if (visit) { select(visit.id); highlight(visit.id); }
    };
    wrapper.addEventListener("click", choose);
    wrapper.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(event); } });
    const marker = new Marker({ element: wrapper, anchor: "center" }).setLngLat(lngLat(stop.point)).addTo(map);
    entries.push({ marker, wrapper, node, stop, shown: true });
  }

  let selectedPlace = first?.place.id;
  const priority = (entry: PinEntry) => {
    if (entry.stop.place.id === selectedPlace) return 1000;
    const phase = entry.node.dataset.phase;
    if (phase && phase !== "stop") return 100;
    return entry.node.dataset.kind === "poi" ? 60 : 10;
  };

  /**
   * Edge-aware captions, then hide the captions (never the badges) that
   * would land on a more important pin: the selected stop, then Start and
   * Finish, then points of interest.
   */
  function declutter() {
    const box = element.getBoundingClientRect();
    const order = entries.filter((entry) => entry.shown).sort((a, b) => priority(b) - priority(a));
    for (const entry of order) {
      entry.wrapper.style.zIndex = String(priority(entry));
      positionMapPin(entry.node, map.project(lngLat(entry.stop.point)).x, element.clientWidth);
      entry.node.classList.remove("journey-pin--quiet");
    }
    const taken: DOMRect[] = order.map((entry) => entry.node.querySelector(".journey-pin__badge")?.getBoundingClientRect()).filter((rect): rect is DOMRect => Boolean(rect));
    // The Day map's own buttons float over the map (the Ground route / Whole day switch).
    for (const control of element.parentElement?.querySelectorAll(".journey-map__scope") ?? []) taken.push(control.getBoundingClientRect());
    const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const entry of order) {
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
    selectedPlace = visit?.place.id;
    for (const entry of entries) entry.node.classList.toggle("journey-pin--selected", entry.stop.place.id === selectedPlace);
    declutter();
  }

  const fit = (includeFlights = false) => {
    wholeScope = includeFlights;
    if (map.getLayer("journey-flight")) map.setLayoutProperty("journey-flight", "visibility", includeFlights ? "visible" : "none");
    const ids = new Set(dayMapVisits(data, includeFlights).map((visit) => visit.place.id));
    for (const entry of entries) {
      updateMapPin(entry.node, entry.stop, data, includeFlights);
      const show = ids.has(entry.stop.place.id);
      if (show && !entry.shown) entry.marker.addTo(map);
      if (!show && entry.shown) entry.marker.remove();
      entry.shown = show;
    }
    const box = bounds(includeFlights);
    if (!box.isEmpty()) map.fitBounds(box, { padding, maxZoom: 16, duration: reducedMotion ? 0 : 400 });
    declutter();
  };

  await new Promise<void>((resolve, reject) => {
    if (map.loaded()) { resolve(); return; }
    map.once("load", () => resolve());
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }).catch((error: unknown) => { map.remove(); throw error; });
  if (first) highlight(first.id);

  const observer = new ResizeObserver(() => map.resize());
  observer.observe(element);
  return {
    fit,
    highlight,
    focus(visitId) {
      const visit = data.visits.find((item) => item.id === visitId);
      if (!visit) return;
      highlight(visitId);
      map.easeTo({ center: lngLat(visit.point), zoom: Math.max(map.getZoom(), visit.kind === "airport" ? 12 : 15), duration: reducedMotion ? 0 : 500 });
    },
    retry() {
      // A full reload, not a diff: the style may be unchanged and only its tiles failed.
      void loadBaseStyle().then((next) => {
        baseMissing = false;
        map.setStyle(next, { diff: false });
      }).catch(() => {
        // Still offline: the route stays drawn on the blank style.
        unavailable(true);
      });
    },
    destroy() {
      observer.disconnect();
      map.remove();
    },
  };
}
