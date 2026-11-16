import { MAP_MODES, dayMapPoints, dayMapVisits, type DayMapData, type MapPoint } from "./day-map.js";

/** A preview is shared through R2; interactive maps are a separate, explicit action. */
export function encodePolyline(points: MapPoint[]): string {
  let previousLat = 0;
  let previousLng = 0;
  let encoded = "";
  const append = (delta: number) => {
    let value = delta < 0 ? -delta * 2 - 1 : delta * 2;
    while (value >= 32) { encoded += String.fromCharCode((value % 32) + 95); value = Math.floor(value / 32); }
    encoded += String.fromCharCode(value + 63);
  };
  for (const [lat, lng] of points) {
    const latitude = Math.round(lat * 1e5);
    const longitude = Math.round(lng * 1e5);
    append(latitude - previousLat);
    append(longitude - previousLng);
    previousLat = latitude;
    previousLng = longitude;
  }
  return encoded;
}

function distanceSquared(point: MapPoint, from: MapPoint, to: MapPoint): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const size = dx * dx + dy * dy;
  const t = size ? Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / size)) : 0;
  return (point[0] - from[0] - t * dx) ** 2 + (point[1] - from[1] - t * dy) ** 2;
}

/** Keep turns visible at preview size without sending every railway vertex to Google. */
export function simplifyPreviewPath(points: MapPoint[], tolerance: number): MapPoint[] {
  if (points.length < 3) return points;
  const keep = new Set([0, points.length - 1]);
  const work: [number, number][] = [[0, points.length - 1]];
  while (work.length) {
    const range = work.pop();
    if (!range) break;
    const [start, end] = range;
    const from = points[start];
    const to = points[end];
    if (!from || !to) continue;
    let farthest = tolerance ** 2;
    let index = -1;
    for (let at = start + 1; at < end; at++) {
      const point = points[at];
      if (!point) continue;
      const distance = distanceSquared(point, from, to);
      if (distance > farthest) { farthest = distance; index = at; }
    }
    if (index >= 0) { keep.add(index); work.push([start, index], [index, end]); }
  }
  return points.filter((_, index) => keep.has(index));
}

export function dayStaticMapUpstream(data: DayMapData, apiKey: string): string | undefined {
  const visits = dayMapVisits(data, false);
  const first = visits[0];
  const last = visits.at(-1);
  if (!first || !last) return;
  const points = dayMapPoints(data, false);
  let minLat = first.point[0], maxLat = minLat, minLng = first.point[1], maxLng = minLng;
  for (const [lat, lng] of points) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
  }
  const tolerance = Math.max((maxLat - minLat) / 480, (maxLng - minLng) / 640, 0.00001) * 1.5;
  for (let detail = 0; detail < 10; detail++) {
    const query = new URLSearchParams({ size: "640x480", scale: "2", language: "en", format: "png", key: apiKey });
    query.append("markers", `color:0x24725f|label:S|${first.point.join(",")}`);
    if (first.place.id !== last.place.id) query.append("markers", `color:0xa43c4c|label:F|${last.point.join(",")}`);
    const seen = new Set([first.place.id, last.place.id]);
    for (const visit of visits) {
      if (seen.has(visit.place.id)) continue;
      seen.add(visit.place.id);
      const label = /^[A-Z0-9]$/.test(visit.label) ? `label:${visit.label}|` : "";
      query.append("markers", `color:0xc23b22|size:mid|${label}${visit.point.join(",")}`);
    }
    for (const path of data.paths) {
      if (path.mode === "flight") continue;
      const simplified = simplifyPreviewPath(path.points, tolerance * 2 ** detail);
      query.append("path", `weight:4|color:${MAP_MODES[path.mode].colour.replace("#", "0x")}ff|enc:${encodePolyline(simplified)}`);
    }
    const url = `https://maps.googleapis.com/maps/api/staticmap?${query}`;
    // Leave margin beneath Google's 16,384-character URL limit.
    if (url.length <= 14_000) return url;
  }
}
