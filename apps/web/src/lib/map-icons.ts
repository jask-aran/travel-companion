import type { Map as MapLibreMap } from "maplibre-gl";
import { PALETTES, POI_CATEGORIES, poiImage, type MapTheme, type PoiCategory } from "./map-style.js";
import { TRAVEL_ICON_PATHS } from "./travel-icons.js";

/**
 * The base map's point-of-interest markers: a disc in the category's colour
 * with a glyph on it. OpenFreeMap's sprite can't be recoloured (none of its
 * icons are SDF), so these are drawn here, once per theme.
 */
const GLYPHS: Record<PoiCategory, string> = {
  // 16x16 stroked paths, like TRAVEL_ICON_PATHS.
  food: "M5 2v4.5a1.5 1.5 0 0 0 3 0V2M6.5 2v12M11.5 2C10.2 3 9.8 5 9.8 7.5h1.7V14",
  shop: "M3.5 5.5h9l-.8 8.5H4.3ZM6 5.5V4a2 2 0 0 1 4 0v1.5",
  sight: "M2.5 6 8 2.5 13.5 6ZM4.2 7.5v5M8 7.5v5M11.8 7.5v5M2.5 13.5h11",
  nature: "M8 14.5v-3.5M8 1.8 3.8 7.5h2.1L3.6 11h8.8L10.1 7.5h2.1Z",
  health: "M6.3 2.5h3.4v3.8h3.8v3.4H9.7v3.8H6.3V9.7H2.5V6.3h3.8Z",
  lodging: TRAVEL_ICON_PATHS.lodging ?? "",
  transit: TRAVEL_ICON_PATHS.transit ?? "",
  other: "M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8Z",
};

const RATIO = 2;
const SIZE = 22;

function marker(category: PoiCategory, theme: MapTheme): ImageData {
  const palette = PALETTES[theme];
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIZE * RATIO;
  const context = canvas.getContext("2d");
  if (!context) return new ImageData(SIZE * RATIO, SIZE * RATIO);
  context.scale(RATIO, RATIO);
  const middle = SIZE / 2;
  context.beginPath();
  context.arc(middle, middle, middle - 1, 0, Math.PI * 2);
  context.fillStyle = palette.halo;
  context.fill();
  context.beginPath();
  context.arc(middle, middle, middle - 2.5, 0, Math.PI * 2);
  context.fillStyle = palette.poiDisc[category];
  context.fill();
  const scale = 0.75;
  context.translate(middle - 8 * scale, middle - 8 * scale);
  context.scale(scale, scale);
  const path = new Path2D(GLYPHS[category]);
  context.strokeStyle = palette.poiGlyph;
  context.lineWidth = 1.9;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (category === "other") {
    context.fillStyle = palette.poiGlyph;
    context.fill(path);
  } else context.stroke(path);
  return context.getImageData(0, 0, SIZE * RATIO, SIZE * RATIO);
}

/** After every style load: a new style drops the images the old one had. */
export function addPoiImages(map: MapLibreMap, theme: MapTheme): void {
  for (const category of POI_CATEGORIES) {
    const id = poiImage(category);
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, marker(category, theme), { pixelRatio: RATIO });
  }
}
