/// <reference types="vite/client" />
import { LngLatBounds, Map as MapLibreMap, setWorkerUrl, type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { MAP_MODES, type MapPath } from "./day-map.js";
import { PALETTES, dayMapStyle, type MapTheme } from "./map-style.js";
import { MAX_ZOOM, SNAPSHOT_PADDING } from "./map-areas.js";

/**
 * Fixed maps for the Day summary: a still image of a group of stops, fitted to
 * them, drawn from our own base map. One hidden MapLibre map draws every
 * picture in turn and is let go when nothing has asked for a while, so a fixed
 * map costs an image, not a live map.
 */
setWorkerUrl(workerUrl);

/** `area` names the town a stop is in and `name` the stop, for the area stepper. */
export type SnapshotStop = { lat: number; lng: number; label: string; hotel?: boolean; area?: string; name?: string };
export type SnapshotLine = { points: [number, number][]; mode: MapPath["mode"]; approximate: boolean };
/** `fit`: the stops (by index) the view is fitted to; all of them when left out. Lines and other stops still draw. */
export type SnapshotRequest = { theme: MapTheme; width: number; height: number; stops: SnapshotStop[]; lines: SnapshotLine[]; zoom?: number; fit?: number[] };

const SOURCE = "snapshot";
let map: MapLibreMap | undefined;
let host: HTMLDivElement | undefined;
let styledFor: MapTheme | undefined;
let release: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<unknown> = Promise.resolve();
const cache = new Map<string, Promise<string>>();

/** Our style without its point-of-interest markers: the fixed map is about your stops. */
function quietStyle(theme: MapTheme): StyleSpecification {
  const style = dayMapStyle(theme);
  return { ...style, layers: style.layers.filter((layer) => !layer.id.startsWith("poi-") && layer.id !== "airport") };
}

function features(request: SnapshotRequest) {
  const dark = request.theme === "dark";
  return {
    type: "FeatureCollection" as const,
    features: [
      ...request.lines.map((line) => ({
        type: "Feature" as const,
        properties: { colour: dark ? MAP_MODES[line.mode].dark : MAP_MODES[line.mode].colour, dashed: line.mode === "walking" || line.approximate },
        geometry: { type: "LineString" as const, coordinates: line.points.map(([lat, lng]) => [lng, lat]) },
      })),
      ...request.stops.map((stop, index) => ({
        type: "Feature" as const,
        // Stops outside the area being shown stay as context, faded.
        properties: { label: stop.label, hotel: Boolean(stop.hotel), faded: Boolean(request.fit && !request.fit.includes(index)) },
        geometry: { type: "Point" as const, coordinates: [stop.lng, stop.lat] },
      })),
    ],
  };
}

function addLayers(target: MapLibreMap, theme: MapTheme): void {
  if (!target.getSource(SOURCE)) target.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  const halo = PALETTES[theme].routeCasing;
  const isLine = ["==", ["geometry-type"], "LineString"] as const;
  const isPoint = ["==", ["geometry-type"], "Point"] as const;
  const layers = [
    { id: "snap-casing", type: "line", filter: isLine, layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": halo, "line-width": 6, "line-opacity": 0.9 } },
    { id: "snap-line", type: "line", filter: ["all", isLine, ["!", ["get", "dashed"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": 3 } },
    { id: "snap-dash", type: "line", filter: ["all", isLine, ["get", "dashed"]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "colour"], "line-width": 3, "line-dasharray": [0, 1.8] } },
    { id: "snap-stop", type: "circle", filter: isPoint, paint: { "circle-radius": 9, "circle-color": ["case", ["get", "hotel"], "#966523", "#bd422d"], "circle-stroke-width": 2, "circle-stroke-color": halo, "circle-opacity": ["case", ["get", "faded"], 0.4, 1], "circle-stroke-opacity": ["case", ["get", "faded"], 0.4, 1] } },
    { id: "snap-label", type: "symbol", filter: isPoint, layout: { "text-field": ["get", "label"], "text-font": ["Noto Sans Bold"], "text-size": 10.5, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#fffaf0", "text-opacity": ["case", ["get", "faded"], 0.5, 1] } },
  ];
  for (const layer of layers) if (!target.getLayer(layer.id)) target.addLayer({ ...layer, source: SOURCE } as Parameters<MapLibreMap["addLayer"]>[0]);
}

const once = (target: MapLibreMap, event: "load" | "idle" | "style.load", ms = 10_000) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    target.once(event, () => { clearTimeout(timer); resolve(); });
  });

async function draw(request: SnapshotRequest): Promise<string> {
  clearTimeout(release);
  if (!host) {
    host = document.createElement("div");
    // Off screen but laid out: WebGL needs a real size to draw into.
    Object.assign(host.style, { position: "fixed", left: "-10000px", top: "0", pointerEvents: "none" });
    document.body.append(host);
  }
  Object.assign(host.style, { width: `${request.width}px`, height: `${request.height}px` });
  if (!map) {
    map = new MapLibreMap({
      container: host,
      style: quietStyle(request.theme),
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      // Keeps the last frame readable for the copy.
      canvasContextAttributes: { preserveDrawingBuffer: true },
    });
    styledFor = request.theme;
    await once(map, "load");
  } else {
    map.resize();
    if (styledFor !== request.theme) {
      map.setStyle(quietStyle(request.theme), { diff: false });
      styledFor = request.theme;
      await once(map, "style.load");
    }
  }
  const target = map;
  addLayers(target, request.theme);
  target.getSource<GeoJSONSource>(SOURCE)?.setData(features(request));
  const fitted = request.fit ? request.fit.map((index) => request.stops[index]).filter((stop) => stop !== undefined) : request.stops;
  // A whole block fits its lines too; an area fits only its stops, and the lines run off the edge.
  const points = [
    ...fitted.map((stop) => [stop.lng, stop.lat] as [number, number]),
    ...(request.fit ? [] : request.lines.flatMap((line) => line.points.map(([lat, lng]) => [lng, lat] as [number, number]))),
  ];
  const distinct = new Set(points.map((point) => point.join())).size;
  if (distinct <= 1) {
    const only = fitted[0];
    if (only) target.jumpTo({ center: [only.lng, only.lat], zoom: request.zoom ?? 15 });
  } else {
    const box = new LngLatBounds();
    for (const point of points) box.extend(point);
    target.fitBounds(box, { padding: SNAPSHOT_PADDING, maxZoom: MAX_ZOOM, duration: 0 });
  }
  await once(target, "idle");
  const image = target.getCanvas().toDataURL("image/webp", 0.86);
  release = setTimeout(() => { map?.remove(); map = undefined; styledFor = undefined; host?.remove(); host = undefined; }, 30_000);
  return image;
}

/** A still image of the request, drawn one at a time and remembered for the session. */
export function mapSnapshot(request: SnapshotRequest): Promise<string> {
  const key = JSON.stringify(request);
  let image = cache.get(key);
  if (!image) {
    image = queue.then(() => draw(request));
    // A failed picture (offline, no WebGL) is asked for again next time.
    image.catch(() => cache.delete(key));
    queue = image.catch(() => undefined);
    cache.set(key, image);
  }
  return image;
}
