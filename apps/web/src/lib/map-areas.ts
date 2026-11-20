/**
 * Areas for a fixed map: groups of stops close enough that, fitted together
 * at phone width, every numbered pin can be told apart. A block whose stops
 * already read in one view stays one area; otherwise stops within walking
 * reach of each other (ARE_NEAR) are grouped, in the order the day reaches them.
 */

export type AreaPoint = { lat: number; lng: number };

/** Pins closer than this on screen sit on top of each other. */
const MIN_GAP_PX = 18;
/** Stops this close belong to the same area, to begin with; an area that still piles up is split closer. */
const ARE_NEAR_METRES = 1500;
/** Below this, stops are as good as one place: no further splitting. */
const SAME_SPOT_METRES = 60;
export const MAX_ZOOM = 17.5;
const TILE = 512;
export type Padding = { top: number; bottom: number; left: number; right: number };
/**
 * Room a fixed map keeps around its fitted stops, measured to pin centres: each
 * side allows for the pin's own radius, and the top for the caption as well.
 */
export const SNAPSHOT_PADDING: Padding = { top: 50, bottom: 26, left: 20, right: 20 };

/** A point in Web Mercator world pixels at zoom 0. */
function world(point: AreaPoint): [number, number] {
  const x = ((point.lng + 180) / 360) * TILE;
  const sin = Math.sin((point.lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE;
  return [x, y];
}

/** The zoom a fit of these points reaches in a box this size, as MapLibre's fitBounds works it out. */
export function fitZoom(points: AreaPoint[], width: number, height: number, padding: Padding): number {
  const xy = points.map(world);
  const dx = Math.max(...xy.map((p) => p[0])) - Math.min(...xy.map((p) => p[0]));
  const dy = Math.max(...xy.map((p) => p[1])) - Math.min(...xy.map((p) => p[1]));
  const scale = Math.min((width - padding.left - padding.right) / Math.max(dx, 1e-9), (height - padding.top - padding.bottom) / Math.max(dy, 1e-9));
  return Math.min(MAX_ZOOM, Math.log2(scale));
}

/** Whether every pin stands apart when these points are fitted together. */
export function readsAsOne(points: AreaPoint[], width: number, height: number, padding: Padding): boolean {
  if (points.length < 2) return true;
  const scale = 2 ** fitZoom(points, width, height, padding);
  const xy = points.map(world);
  for (let i = 0; i < xy.length; i += 1) {
    for (let j = i + 1; j < xy.length; j += 1) {
      const gap = Math.hypot(xy[i]![0] - xy[j]![0], xy[i]![1] - xy[j]![1]) * scale;
      // The same place twice (a return visit) is one pin by design.
      if (gap > 0.5 && gap < MIN_GAP_PX) return false;
    }
  }
  return true;
}

function metres(a: AreaPoint, b: AreaPoint): number {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

/** Stops within `near` of each other, directly or through another stop, grouped; each group in route order. */
function groups(points: AreaPoint[], indexes: number[], near: number): number[][] {
  const parent = new Map(indexes.map((index) => [index, index]));
  const root = (i: number): number => {
    const up = parent.get(i)!;
    if (up === i) return i;
    const top = root(up);
    parent.set(i, top);
    return top;
  };
  for (let a = 0; a < indexes.length; a += 1) {
    for (let b = a + 1; b < indexes.length; b += 1) {
      const i = indexes[a]!;
      const j = indexes[b]!;
      if (metres(points[i]!, points[j]!) <= near) parent.set(root(i), root(j));
    }
  }
  const out = new Map<number, number[]>();
  for (const index of indexes) out.set(root(index), [...(out.get(root(index)) ?? []), index]);
  return [...out.values()];
}

/** Areas whose pins can each be told apart: split at `near`, then closer, until they read. */
function split(points: AreaPoint[], indexes: number[], near: number, size: [number, number, Padding]): number[][] {
  const read = (set: number[]) => readsAsOne(set.map((index) => points[index]!), ...size);
  if (read(indexes) || near < SAME_SPOT_METRES) return [indexes];
  return groups(points, indexes, near).flatMap((group) => split(points, group, near / 2, size));
}

/** Stop indexes grouped into areas, each in route order, the areas ordered by their first stop. */
export function mapAreas(points: AreaPoint[], width: number, height: number, padding: Padding): number[][] {
  const size: [number, number, Padding] = [width, height, padding];
  const areas = split(points, points.map((_, index) => index), ARE_NEAR_METRES, size).sort((a, b) => a[0]! - b[0]!);
  // Neighbouring areas that still read together are one: fewer steps.
  const merged: number[][] = [];
  for (const next of areas) {
    const last = merged.at(-1);
    const both = last ? [...last, ...next].sort((a, b) => a - b) : undefined;
    if (last && both && readsAsOne(both.map((index) => points[index]!), ...size)) merged[merged.length - 1] = both;
    else merged.push(next);
  }
  return merged;
}
