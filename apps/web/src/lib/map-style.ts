import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

/**
 * The Day map's base map: our own style over OpenFreeMap's OpenMapTiles
 * vector tiles, in a light and a dark palette. Like Google's maps, colour says
 * what an area is (parks, hospitals, schools, shopping streets) and what a
 * point is (food, shops, sights, transit), so a glance tells you what is
 * around a stop.
 *
 * The layer structure and label expressions follow OSM Liberty / OSM Bright
 * (code BSD-3-Clause, design CC BY 4.0), which proved them on Japanese and
 * Korean data; every colour here is ours.
 */
export type MapTheme = "light" | "dark";

const TILES = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const SOURCE = "openmaptiles";

/** What a point of interest is, as one colour and one marker. */
export type PoiCategory = "food" | "shop" | "sight" | "nature" | "health" | "lodging" | "transit" | "other";
export const POI_CATEGORIES: PoiCategory[] = ["food", "shop", "sight", "nature", "health", "lodging", "transit", "other"];
export const poiImage = (category: PoiCategory) => `poi-${category}`;

/** OpenMapTiles `poi.class` values per category; anything else is "other". */
const POI_CLASSES: Record<Exclude<PoiCategory, "other">, string[]> = {
  food: ["restaurant", "fast_food", "cafe", "bar", "beer", "ice_cream", "bakery", "food_court"],
  shop: ["shop", "grocery", "clothing_store", "alcohol_shop", "gift", "furniture", "florist", "jewelry", "books", "convenience", "supermarket", "department_store", "mall"],
  sight: ["attraction", "museum", "art_gallery", "castle", "monument", "theatre", "cinema", "zoo", "aquarium", "amusement_park", "music", "place_of_worship", "library", "viewpoint"],
  nature: ["park", "garden", "campsite", "picnic_site", "playground", "dog_park", "golf", "swimming", "stadium", "pitch"],
  health: ["hospital", "doctors", "dentist", "pharmacy", "veterinary"],
  lodging: ["lodging"],
  transit: ["railway", "rail", "bus", "aerialway", "ferry_terminal", "harbor"],
};

type Palette = {
  land: string;
  residential: string;
  wood: string;
  grass: string;
  park: string;
  parkOutline: string;
  wetland: string;
  sand: string;
  ice: string;
  water: string;
  waterLabel: string;
  hospital: string;
  school: string;
  commercial: string;
  industrial: string;
  cemetery: string;
  pitch: string;
  railLand: string;
  aeroway: string;
  runway: string;
  building: string;
  buildingOutline: string;
  motorway: string;
  motorwayCasing: string;
  trunk: string;
  trunkCasing: string;
  road: string;
  roadCasing: string;
  minor: string;
  minorCasing: string;
  tunnel: string;
  path: string;
  rail: string;
  railHatch: string;
  ferry: string;
  boundary: string;
  label: string;
  labelMinor: string;
  roadLabel: string;
  halo: string;
  poi: Record<PoiCategory, string>;
  /** The disc behind each POI glyph, and the glyph itself. */
  poiDisc: Record<PoiCategory, string>;
  poiGlyph: string;
  /** Our own route's casing, arrow halo and the map's blank fallback. */
  routeCasing: string;
};

export const PALETTES: Record<MapTheme, Palette> = {
  light: {
    land: "#f5f3ee",
    residential: "#efebe4",
    wood: "#c3e2b7",
    grass: "#d4ecca",
    park: "#cbe8c1",
    parkOutline: "#a9d39c",
    wetland: "#d3e9e1",
    sand: "#f2e9cc",
    ice: "#ffffff",
    water: "#a5cdf0",
    waterLabel: "#2f6aa3",
    hospital: "#f6dbdb",
    school: "#f2e8cf",
    commercial: "#f8e6d6",
    industrial: "#e7e3ec",
    cemetery: "#d9e6d2",
    pitch: "#c9e6c0",
    railLand: "#ebe7ee",
    aeroway: "#e4e6ee",
    runway: "#d2d5df",
    building: "#e7e2da",
    buildingOutline: "#d9d3c9",
    motorway: "#f8cf73",
    motorwayCasing: "#dca64a",
    trunk: "#fde3a2",
    trunkCasing: "#e1be78",
    road: "#ffffff",
    roadCasing: "#d6cfc4",
    minor: "#ffffff",
    minorCasing: "#e0dad0",
    tunnel: "#f1ede6",
    path: "#b9b0a2",
    rail: "#9a95a3",
    railHatch: "#f5f3ee",
    ferry: "#5f97c9",
    boundary: "#9b96a6",
    label: "#2c3236",
    labelMinor: "#5d6468",
    roadLabel: "#5b5f63",
    halo: "#ffffff",
    poi: { food: "#c45a00", shop: "#2f5fc4", sight: "#0e7a79", nature: "#2b7a36", health: "#c0352a", lodging: "#b0225a", transit: "#3d5a86", other: "#5f6873" },
    poiDisc: { food: "#e8710a", shop: "#3f72e0", sight: "#12918f", nature: "#34a047", health: "#db4437", lodging: "#c2185b", transit: "#4a6a9c", other: "#7b8590" },
    poiGlyph: "#ffffff",
    routeCasing: "#fffdf8",
  },
  dark: {
    land: "#18202a",
    residential: "#1c2530",
    wood: "#1b3326",
    grass: "#1e3529",
    park: "#1d3a2b",
    parkOutline: "#2a5039",
    wetland: "#1c3330",
    sand: "#353122",
    ice: "#2a333e",
    water: "#0e2c44",
    waterLabel: "#79a9d4",
    hospital: "#3a2329",
    school: "#322e26",
    commercial: "#33281f",
    industrial: "#252633",
    cemetery: "#20302a",
    pitch: "#1e3a29",
    railLand: "#222632",
    aeroway: "#232a35",
    runway: "#323b48",
    building: "#232c37",
    buildingOutline: "#2c3743",
    motorway: "#7a6236",
    motorwayCasing: "#594827",
    trunk: "#5e5340",
    trunkCasing: "#463d2f",
    road: "#3a4552",
    roadCasing: "#26303b",
    minor: "#323c48",
    minorCasing: "#222b35",
    tunnel: "#27303b",
    path: "#55606c",
    rail: "#5d6672",
    railHatch: "#18202a",
    ferry: "#4f84b3",
    boundary: "#6b7482",
    label: "#d8dee5",
    labelMinor: "#9ba6b1",
    roadLabel: "#a3adb7",
    halo: "#18202a",
    poi: { food: "#f4a35a", shop: "#86acf5", sight: "#52c2bd", nature: "#72c47f", health: "#f28b80", lodging: "#f48fb1", transit: "#9fb6d8", other: "#a6afba" },
    poiDisc: { food: "#f0a050", shop: "#7ea6f2", sight: "#4dbab5", nature: "#6cbb78", health: "#ee857a", lodging: "#ef8aad", transit: "#98afd2", other: "#9da7b2" },
    poiGlyph: "#10161d",
    routeCasing: "#10161d",
  },
};

const get = (key: string): ExpressionSpecification => ["get", key];
const classIn = (...values: string[]): ExpressionSpecification => ["match", get("class"), values, true, false];
const notBrunnel: ExpressionSpecification = ["match", get("brunnel"), ["bridge", "tunnel"], false, true];
const isLine: ExpressionSpecification = ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false];
const isPoint: ExpressionSpecification = ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false];

/** Latin name with the local script beneath, as OSM Liberty does. */
const NAME: ExpressionSpecification = ["case", ["has", "name:nonlatin"], ["concat", get("name:latin"), "\n", get("name:nonlatin")], ["coalesce", get("name_en"), get("name")]];
const NAME_ONE_LINE: ExpressionSpecification = ["case", ["has", "name:nonlatin"], ["concat", get("name:latin"), " ", get("name:nonlatin")], ["coalesce", get("name_en"), get("name")]];
const REGULAR = ["Noto Sans Regular"];
const BOLD = ["Noto Sans Bold"];
const ITALIC = ["Noto Sans Italic"];

const ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "minor", "service", "track", "busway", "raceway"];

/** Road width by class, growing with zoom. `extra` widens it for the casing. */
function roadWidth(extra: number): ExpressionSpecification {
  const at = (motorway: number, major: number, mid: number, minor: number, service: number): ExpressionSpecification =>
    ["match", get("class"), "motorway", motorway + extra, ["trunk", "primary"], major + extra, ["secondary", "tertiary"], mid + extra, ["minor", "busway"], minor + extra, service + extra];
  return ["interpolate", ["exponential", 1.4], ["zoom"], 5, at(0.6, 0.3, 0, 0, 0), 10, at(2, 1.4, 0.8, 0.3, 0), 13, at(4, 3, 2, 1, 0.4), 16, at(10, 8, 6.5, 5, 2.5), 20, at(30, 26, 22, 18, 10)];
}
/** Draw bigger roads above smaller ones within one layer. */
const ROAD_ORDER: ExpressionSpecification = ["match", get("class"), "motorway", 6, "trunk", 5, "primary", 4, ["secondary", "tertiary"], 3, "minor", 2, 1];

/** Category of a POI from its OpenMapTiles class. */
function poiCategoryExpression(): ExpressionSpecification {
  const branches: (string | string[])[] = [];
  for (const [category, classes] of Object.entries(POI_CLASSES)) branches.push(classes, category);
  return ["match", get("class"), ...branches, "other"] as unknown as ExpressionSpecification;
}
const byCategory = (colours: Record<PoiCategory, string>): ExpressionSpecification => {
  const branches: (string | string[])[] = [];
  for (const [category, classes] of Object.entries(POI_CLASSES)) branches.push(classes, colours[category as PoiCategory]);
  return ["match", get("class"), ...branches, colours.other] as unknown as ExpressionSpecification;
};

function poiLayer(id: string, minzoom: number, rankFilter: ExpressionSpecification, palette: Palette, which: "categorised" | "all" | "other" = "categorised"): LayerSpecification {
  return {
    id, type: "symbol", source: SOURCE, "source-layer": "poi", minzoom,
    // Stations get their own layer, shown from further out. Points that are
    // none of our categories (offices, gates, unnamed services) wait until
    // close in, so the coloured ones read first.
    filter: ["all", isPoint, rankFilter, ["!", classIn(...POI_CLASSES.transit)], ...(which === "all" ? [] : [[which === "other" ? "==" : "!=", poiCategoryExpression(), "other"] as ExpressionSpecification])],
    layout: {
      "icon-image": ["concat", "poi-", poiCategoryExpression()],
      "icon-size": 1,
      "symbol-sort-key": get("rank"),
      "text-field": NAME,
      "text-font": REGULAR,
      "text-size": 11.5,
      "text-max-width": 8,
      "text-anchor": "top",
      "text-offset": [0, 0.9],
      "text-optional": true,
    },
    paint: {
      "text-color": byCategory(palette.poi),
      "text-halo-color": palette.halo,
      "text-halo-width": 1.4,
      "text-halo-blur": 0.3,
    },
  };
}

function placeLabel(id: string, classes: string[], minzoom: number, size: ExpressionSpecification | number, palette: Palette, options: { bold?: boolean; minor?: boolean; quiet?: boolean; maxzoom?: number } = {}): LayerSpecification {
  return {
    id, type: "symbol", source: SOURCE, "source-layer": "place", minzoom, ...(options.maxzoom ? { maxzoom: options.maxzoom } : {}),
    filter: classIn(...classes),
    layout: {
      "text-field": NAME,
      "text-font": options.bold ? BOLD : REGULAR,
      "text-size": size,
      "text-max-width": 8,
      "symbol-sort-key": ["coalesce", get("rank"), 99],
      ...(options.minor ? { "text-transform": "uppercase", "text-letter-spacing": 0.08 } : {}),
    },
    paint: {
      "text-color": options.minor || options.quiet ? palette.labelMinor : palette.label,
      "text-halo-color": palette.halo,
      "text-halo-width": 1.5,
      "text-halo-blur": 0.5,
    },
  };
}

function layers(palette: Palette): LayerSpecification[] {
  const tunnel: ExpressionSpecification = ["==", get("brunnel"), "tunnel"];
  const bridge: ExpressionSpecification = ["==", get("brunnel"), "bridge"];
  const roads = classIn(...ROAD_CLASSES);
  const roadColour = (fill: boolean): ExpressionSpecification => fill
    ? ["match", get("class"), "motorway", palette.motorway, "trunk", palette.trunk, ["primary", "secondary", "tertiary"], palette.road, palette.minor]
    : ["match", get("class"), "motorway", palette.motorwayCasing, "trunk", palette.trunkCasing, ["primary", "secondary", "tertiary"], palette.roadCasing, palette.minorCasing];
  const roadMinzoom: ExpressionSpecification = ["match", get("class"), ["motorway", "trunk", "primary"], true, ["secondary", "tertiary"], [">=", ["zoom"], 9], ["minor", "busway"], [">=", ["zoom"], 12], [">=", ["zoom"], 14]];
  const round = { "line-cap": "round", "line-join": "round" } as const;
  const casingFor = (id: string, filter: ExpressionSpecification, dashed = false): LayerSpecification => ({
    id, type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 5,
    filter: ["all", isLine, roads, roadMinzoom, filter],
    layout: { "line-join": "round", "line-sort-key": ROAD_ORDER },
    paint: { "line-color": roadColour(false), "line-width": roadWidth(1.6), ...(dashed ? { "line-dasharray": [0.6, 0.5] } : {}), "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 12, 1] },
  });
  const fillFor = (id: string, filter: ExpressionSpecification, colour?: string): LayerSpecification => ({
    id, type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 5,
    filter: ["all", isLine, roads, roadMinzoom, filter],
    layout: { ...round, "line-sort-key": ROAD_ORDER },
    paint: { "line-color": colour ?? roadColour(true), "line-width": roadWidth(0) },
  });
  const railFor = (id: string, filter: ExpressionSpecification, opacity = 1): LayerSpecification[] => [
    { id, type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 8, filter: ["all", isLine, classIn("rail", "transit"), filter],
      paint: { "line-color": palette.rail, "line-opacity": opacity, "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 8, 0.6, 14, 2, 18, 4] } },
    // Railway hatching: a pale dash along the line, the way paper maps draw track.
    { id: `${id}-hatching`, type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 13, filter: ["all", isLine, classIn("rail"), filter],
      paint: { "line-color": palette.railHatch, "line-opacity": opacity, "line-dasharray": [0.2, 6], "line-width": ["interpolate", ["exponential", 1.4], ["zoom"], 13, 3, 18, 7] } },
  ];

  return [
    { id: "background", type: "background", paint: { "background-color": palette.land } },
    { id: "landcover", type: "fill", source: SOURCE, "source-layer": "landcover",
      filter: classIn("wood", "grass", "farmland", "wetland", "sand", "ice", "rock"),
      paint: { "fill-color": ["match", get("class"), "wood", palette.wood, ["grass", "farmland"], palette.grass, "wetland", palette.wetland, "sand", palette.sand, "ice", palette.ice, palette.residential],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 5, 0.5, 10, 0.9] } },
    { id: "landuse-residential", type: "fill", source: SOURCE, "source-layer": "landuse", maxzoom: 14, filter: classIn("residential", "suburb", "neighbourhood"),
      paint: { "fill-color": palette.residential, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 14, 0] } },
    // Areas of interest, coloured by what they are.
    { id: "landuse", type: "fill", source: SOURCE, "source-layer": "landuse",
      filter: classIn("hospital", "school", "university", "college", "kindergarten", "commercial", "retail", "industrial", "cemetery", "stadium", "pitch", "playground", "railway", "military", "zoo", "theme_park"),
      paint: {
        "fill-color": ["match", get("class"),
          "hospital", palette.hospital,
          ["school", "university", "college", "kindergarten"], palette.school,
          ["commercial", "retail"], palette.commercial,
          ["industrial", "military"], palette.industrial,
          "cemetery", palette.cemetery,
          ["stadium", "pitch", "playground", "zoo", "theme_park"], palette.pitch,
          palette.railLand],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 13, 1],
      } },
    { id: "park", type: "fill", source: SOURCE, "source-layer": "park", paint: { "fill-color": palette.park } },
    { id: "park-outline", type: "line", source: SOURCE, "source-layer": "park", minzoom: 12, paint: { "line-color": palette.parkOutline, "line-width": 0.8 } },
    { id: "waterway", type: "line", source: SOURCE, "source-layer": "waterway", filter: ["!=", get("brunnel"), "tunnel"],
      paint: { "line-color": palette.water, "line-width": ["interpolate", ["exponential", 1.3], ["zoom"], 8, ["match", get("class"), "river", 1, 0.4], 18, ["match", get("class"), "river", 12, 4]] } },
    { id: "water", type: "fill", source: SOURCE, "source-layer": "water", filter: ["!=", get("brunnel"), "tunnel"], paint: { "fill-color": palette.water } },
    { id: "aeroway-area", type: "fill", source: SOURCE, "source-layer": "aeroway", minzoom: 10, filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], paint: { "fill-color": palette.aeroway } },
    { id: "aeroway-runway", type: "line", source: SOURCE, "source-layer": "aeroway", minzoom: 10, filter: ["all", isLine, classIn("runway", "taxiway")],
      paint: { "line-color": palette.runway, "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 10, ["match", get("class"), "runway", 2, 0.5], 17, ["match", get("class"), "runway", 40, 12]] } },
    { id: "building", type: "fill", source: SOURCE, "source-layer": "building", minzoom: 14,
      paint: { "fill-color": palette.building, "fill-outline-color": palette.buildingOutline, "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14, 0, 15, 1] } },

    casingFor("tunnel-casing", tunnel, true),
    fillFor("tunnel", tunnel, palette.tunnel),
    ...railFor("tunnel-rail", tunnel, 0.45),
    { id: "path", type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 14, filter: ["all", isLine, classIn("path", "pedestrian"), ["!=", get("brunnel"), "tunnel"]],
      paint: { "line-color": palette.path, "line-dasharray": [1.5, 1], "line-width": ["interpolate", ["linear"], ["zoom"], 14, 0.8, 18, 2.5] } },
    casingFor("road-casing", notBrunnel),
    fillFor("road", notBrunnel),
    ...railFor("rail", ["!=", get("brunnel"), "tunnel"]),
    casingFor("bridge-casing", bridge),
    fillFor("bridge", bridge),
    { id: "ferry", type: "line", source: SOURCE, "source-layer": "transportation", minzoom: 8, filter: ["all", isLine, classIn("ferry")],
      paint: { "line-color": palette.ferry, "line-width": 1.2, "line-dasharray": [2, 2] } },

    { id: "boundary-region", type: "line", source: SOURCE, "source-layer": "boundary", minzoom: 3,
      filter: ["all", ["==", ["typeof", get("admin_level")], "number"], [">=", get("admin_level"), 3], ["<=", get("admin_level"), 4], ["!=", get("maritime"), 1]],
      paint: { "line-color": palette.boundary, "line-dasharray": [3, 2], "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.5, 12, 1.2], "line-opacity": 0.6 } },
    { id: "boundary-country", type: "line", source: SOURCE, "source-layer": "boundary",
      filter: ["all", ["==", get("admin_level"), 2], ["!=", get("maritime"), 1]],
      paint: { "line-color": palette.boundary, "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.6, 10, 2] } },

    { id: "water-name", type: "symbol", source: SOURCE, "source-layer": "water_name", filter: isPoint,
      layout: { "text-field": NAME, "text-font": ITALIC, "text-size": 12, "text-max-width": 7 },
      paint: { "text-color": palette.waterLabel, "text-halo-color": palette.halo, "text-halo-width": 1 } },
    { id: "waterway-name", type: "symbol", source: SOURCE, "source-layer": "waterway", minzoom: 13, filter: isLine,
      layout: { "symbol-placement": "line", "text-field": NAME_ONE_LINE, "text-font": ITALIC, "text-size": 11, "text-letter-spacing": 0.1 },
      paint: { "text-color": palette.waterLabel, "text-halo-color": palette.halo, "text-halo-width": 1 } },
    { id: "road-name", type: "symbol", source: SOURCE, "source-layer": "transportation_name", minzoom: 13,
      filter: ["all", isLine, ["match", get("class"), ["motorway", "trunk", "primary", "secondary", "tertiary"], true, ["minor", "service"], [">=", ["zoom"], 15], false]],
      layout: { "symbol-placement": "line", "text-field": NAME_ONE_LINE, "text-font": REGULAR, "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10.5, 17, 12.5], "text-rotation-alignment": "map" },
      paint: { "text-color": palette.roadLabel, "text-halo-color": palette.halo, "text-halo-width": 1.4 } },

    poiLayer("poi-rank-1", 14, ["<=", get("rank"), 6], palette),
    poiLayer("poi-rank-7", 16, ["all", [">", get("rank"), 6], ["<", get("rank"), 20]], palette),
    poiLayer("poi-rank-20", 17, [">=", get("rank"), 20], palette, "all"),
    poiLayer("poi-other", 17, ["<", get("rank"), 20], palette, "other"),
    // Stations from further out than other points: they are how a day moves.
    { id: "poi-station", type: "symbol", source: SOURCE, "source-layer": "poi", minzoom: 12,
      filter: ["all", isPoint, ["any", ["all", classIn("railway", "rail"), ["match", get("subclass"), ["station", "halt", "subway"], true, false]], ["all", classIn(...POI_CLASSES.transit), [">=", ["zoom"], 16]]]],
      layout: { "icon-image": poiImage("transit"), "text-field": NAME, "text-font": REGULAR, "text-size": 11.5, "text-max-width": 9, "text-anchor": "left", "text-offset": [0.95, 0], "text-optional": true, "symbol-sort-key": get("rank") },
      paint: { "text-color": palette.poi.transit, "text-halo-color": palette.halo, "text-halo-width": 1.4 } },
    { id: "airport", type: "symbol", source: SOURCE, "source-layer": "aerodrome_label", minzoom: 8, filter: ["has", "iata"],
      layout: { "icon-image": poiImage("transit"), "text-field": NAME, "text-font": REGULAR, "text-size": 12, "text-anchor": "top", "text-offset": [0, 0.9], "text-optional": true },
      paint: { "text-color": palette.poi.transit, "text-halo-color": palette.halo, "text-halo-width": 1.4 } },

    placeLabel("place-neighbourhood", ["neighbourhood", "quarter", "suburb", "hamlet", "isolated_dwelling"], 12, ["interpolate", ["linear"], ["zoom"], 12, 10, 16, 12], palette, { minor: true }),
    placeLabel("place-village", ["village"], 10, ["interpolate", ["linear"], ["zoom"], 10, 11, 15, 14], palette),
    placeLabel("place-town", ["town"], 7, ["interpolate", ["linear"], ["zoom"], 7, 11, 14, 16], palette),
    placeLabel("place-city", ["city"], 4, ["interpolate", ["exponential", 1.2], ["zoom"], 4, 11, 7, 13, 11, 18], palette, { bold: true }),
    placeLabel("place-state", ["state", "province"], 5, 11, palette, { quiet: true, maxzoom: 8 }),
    placeLabel("place-country", ["country"], 1, ["interpolate", ["linear"], ["zoom"], 2, 11, 6, 15], palette, { bold: true, maxzoom: 8 }),
  ];
}

export function dayMapStyle(theme: MapTheme): StyleSpecification {
  return {
    version: 8,
    name: `Travel Companion ${theme}`,
    sources: {
      [SOURCE]: {
        type: "vector",
        url: TILES,
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> · Style after OSM Liberty',
      },
    },
    glyphs: GLYPHS,
    layers: layers(PALETTES[theme]),
  };
}
