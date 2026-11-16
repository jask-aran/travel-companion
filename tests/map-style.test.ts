import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { POI_CATEGORIES, dayMapStyle } from "../apps/web/src/lib/map-style.js";

// The style spec ships with maplibre-gl; resolve it from there rather than adding a dependency.
const fromMapLibre = createRequire(resolve(import.meta.dirname, "../apps/web/node_modules/maplibre-gl/package.json"));
const { validateStyleMin } = fromMapLibre("@maplibre/maplibre-gl-style-spec") as { validateStyleMin: (style: unknown) => { message: string }[] };

describe("Day map base style", () => {
  it.each(["light", "dark"] as const)("is a valid MapLibre style in %s", (theme) => {
    expect(validateStyleMin(dayMapStyle(theme)).map((error) => error.message)).toEqual([]);
  });
  it("draws the same layers in both themes, so switching only repaints", () => {
    const ids = (theme: "light" | "dark") => dayMapStyle(theme).layers.map((layer) => layer.id);
    expect(ids("dark")).toEqual(ids("light"));
  });
  it("asks only for marker images the map adds itself", () => {
    const wanted = JSON.stringify(dayMapStyle("light").layers);
    for (const name of wanted.match(/poi-[a-z]+/g) ?? []) {
      if (name.startsWith("poi-rank") || name === "poi-station") continue;
      expect(POI_CATEGORIES.map((category) => `poi-${category}`)).toContain(name);
    }
  });
});
