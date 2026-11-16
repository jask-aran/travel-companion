import { For, Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { TripBundle } from "@travel-companion/trip-schema";
import type { DayRouting } from "../lib/day-routing";
import { MAP_MODES, buildDayMap, type DayMapData } from "../lib/day-map";
import type { mountDayMap } from "../lib/map-view";

type MapView = ReturnType<typeof mountDayMap>;

export function DayMap(props: { routing: DayRouting; bundle: TripBundle; stayPlaceIds: Set<string> }) {
  let section!: HTMLElement;
  let canvas!: HTMLDivElement;
  const [nearby, setNearby] = createSignal(false);
  const [data, setData] = createSignal<DayMapData>();
  const [view, setView] = createSignal<MapView>();
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [tilesUnavailable, setTilesUnavailable] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);

  onMount(() => {
    if (!("IntersectionObserver" in window)) { setNearby(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(section);
    onCleanup(() => observer.disconnect());
  });

  createEffect(on([nearby, () => props.bundle.revision, attempt], ([visible]) => {
    if (!visible) return;
    // Departure-board updates don't move the map while somebody is exploring it.
    const next = untrack(() => buildDayMap(props.routing, props.bundle, props.stayPlaceIds));
    setData(next);
    setFailed(false);
    setTilesUnavailable(false);
    setLoading(next.stops.length > 0);
    let disposed = false;
    let mounted: MapView | undefined;
    onCleanup(() => { disposed = true; mounted?.destroy(); setView(undefined); });
    if (!next.stops.length) return;
    void import("../lib/map-view").then(({ mountDayMap }) => {
      if (disposed) return;
      mounted = mountDayMap(canvas, next, setTilesUnavailable);
      setView(mounted);
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoading(false);
      setFailed(true);
    });
  }));

  const legend = () => [...new Set(data()?.paths.map((path) => path.mode) ?? [])];

  return (
    <section class="day-map" classList={{ "day-map--expanded": expanded() }} ref={section} aria-label="Day map">
      <div class="day-map__heading">
        <h3 class="day-part__label">Day map</h3>
        <Show when={view()}>
          <div class="day-map__actions">
            <button type="button" class="day-map__button" onClick={() => view()?.fit()}>Fit day</button>
            <button type="button" class="day-map__button" aria-expanded={expanded()} onClick={() => {
              setExpanded(!expanded());
              if (expanded()) section.scrollIntoView({ block: "start", behavior: "instant" });
            }}>{expanded() ? "Shrink map" : "Expand map"}</button>
          </div>
        </Show>
      </div>
      <div class="day-map__surface">
        <div class="day-map__canvas" ref={canvas} role="region" aria-label="Interactive day map" />
        <Show when={!nearby() || loading()}><p class="day-map__state" role="status">Loading map…</p></Show>
        <Show when={failed()}>
          <div class="day-map__state" role="status"><p>Couldn’t load the map.</p><button type="button" class="day-map__button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div>
        </Show>
        <Show when={data()?.stops.length === 0}><p class="day-map__state">No mapped places for this day.</p></Show>
      </div>
      <Show when={tilesUnavailable()}><div class="day-map__notice" role="status"><p>Street map unavailable. Stops and paths are still shown.</p><button type="button" class="day-map__button" onClick={() => view()?.retryTiles()}>Retry street map</button></div></Show>
      <Show when={data()?.missingPlaces}><p class="day-map__notice">Some stops have no map location.</p></Show>
      <Show when={view()}>
        <div class="day-map__legend">
          <span><b class="day-map__hotel-key">H</b> Hotel</span>
          <For each={legend()}>{(mode) => <span><i class="day-map__line" style={{ "--map-line-colour": MAP_MODES[mode].colour }} />{MAP_MODES[mode].label}</span>}</For>
          <Show when={data()?.paths.some((path) => path.approximate && path.mode !== "flight")}><span>Dashed connections are approximate</span></Show>
          <Show when={data()?.paths.some((path) => path.mode === "flight")}><span>Flights shown schematically</span></Show>
        </div>
      </Show>
    </section>
  );
}
