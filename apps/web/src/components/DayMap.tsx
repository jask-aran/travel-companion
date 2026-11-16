import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { TripBundle } from "@travel-companion/trip-schema";
import type { DayRouting } from "../lib/day-routing";
import { MAP_MODES, buildDayMap, dayMapVisits, type DayMapView, type MapVisit } from "../lib/day-map";
import { buildGoogleMapsUrl, buildGooglePlaceUrl } from "../lib/maps";
import { cityOf, formatCategory } from "../lib/format";
import { TRAVEL_ICON_PATHS } from "../lib/travel-icons";
import { Icon } from "./Icon";

function StopIcon(props: { visit: MapVisit }) {
  const path = () => props.visit.kind === "poi" ? undefined : TRAVEL_ICON_PATHS[props.visit.kind === "hotel" ? "lodging" : props.visit.kind === "airport" ? "flight" : "transit"];
  return <Show when={path()} fallback={<span>{props.visit.label}</span>}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={path()} /></svg></Show>;
}

export function DayMap(props: { routing: DayRouting; bundle: TripBundle; stayPlaceIds: Set<string> }) {
  let section!: HTMLElement;
  let canvas!: HTMLDivElement;
  let rail: HTMLDivElement | undefined;
  const [nearby, setNearby] = createSignal(false);
  const data = createMemo(on(() => props.bundle.revision, () => untrack(() => buildDayMap(props.routing, props.bundle, props.stayPlaceIds))));
  const [view, setView] = createSignal<DayMapView>();
  const [selectedId, setSelectedId] = createSignal(dayMapVisits(data(), false)[0]?.id ?? "");
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [includeFlights, setIncludeFlights] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const visits = () => dayMapVisits(data(), includeFlights());
  const first = () => visits()[0];
  const last = () => visits().at(-1);
  const selected = () => data().visits.find((visit) => visit.id === selectedId()) ?? first();
  const hasFlights = () => data().paths.some((path) => path.mode === "flight");
  const poiCount = () => new Set(visits().filter((visit) => visit.kind === "poi").map((visit) => visit.place.id)).size;
  const label = (visit: MapVisit) => visit.id === first()?.id ? "Start" : visit.id === last()?.id ? (visit.place.id === first()?.place.id ? "Return" : "Finish") : visit.kind === "hotel" ? "Hotel" : `Stop ${visit.label}`;
  const locationName = (visit: MapVisit) => visit.place.locality ?? cityOf(visit.place.address) ?? visit.place.name;

  onMount(() => {
    if (!("IntersectionObserver" in window)) { setNearby(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(section);
    onCleanup(() => observer.disconnect());
  });

  createEffect(on([nearby, data, attempt], ([visible, next]) => {
    if (!visible) return;
    setFailed(false);
    setUnavailable(false);
    setLoading(next.stops.length > 0);
    setIncludeFlights(false);
    setSelectedId(dayMapVisits(next, false)[0]?.id ?? "");
    const controller = new AbortController();
    let mounted: DayMapView | undefined;
    onCleanup(() => { controller.abort(); mounted?.destroy(); setView(undefined); });
    if (!next.stops.length) return;
    const render = async () => {
      // MapLibre is large; it loads only when a Day map comes near the screen.
      const { mountMapLibreDayMap } = await import("../lib/maplibre-view");
      controller.signal.throwIfAborted();
      return mountMapLibreDayMap(canvas, next, setSelectedId, setUnavailable, controller.signal);
    };
    void render().then((ready) => {
      if (controller.signal.aborted) { ready.destroy(); return; }
      mounted = ready;
      setView(ready);
      setLoading(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setFailed(true);
    });
  }));

  createEffect(() => {
    const id = selectedId();
    const index = visits().findIndex((visit) => visit.id === id);
    const button = rail?.children.item(index);
    if (button instanceof HTMLElement && rail) rail.scrollTo({ left: button.offsetLeft - rail.offsetLeft - 8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  });
  const choose = (visit: MapVisit) => { setSelectedId(visit.id); view()?.focus(visit.id); };
  const legend = () => [...new Set(data().paths.filter((path) => includeFlights() || path.mode !== "flight").map((path) => path.mode))];
  const showWholeDay = (whole: boolean) => { setIncludeFlights(whole); setSelectedId(first()?.id ?? ""); view()?.fit(whole); if (first()) view()?.highlight(first()?.id ?? ""); };

  return (
    <section class="day-map journey-map" classList={{ "day-map--expanded": expanded() }} ref={section} aria-label="Day map">
      <div class="day-map__heading">
        <div><h3 class="day-part__label">Day map</h3><p class="journey-map__subheading">{new Set(visits().map((visit) => visit.place.id)).size} places<Show when={poiCount()}> · {poiCount()} {poiCount() === 1 ? "point of interest" : "points of interest"}</Show></p></div>
        <Show when={view()}><div class="day-map__actions"><button type="button" class="day-map__button" onClick={() => view()?.fit(includeFlights())}>Fit day</button><button type="button" class="day-map__button" aria-label={expanded() ? "Shrink map" : "Expand map"} aria-expanded={expanded()} onClick={() => {
          setExpanded(!expanded());
          if (expanded()) section.scrollIntoView({ block: "start", behavior: "instant" });
        }}>{expanded() ? "Shrink" : "Expand"}</button></div></Show>
      </div>
      <div class="journey-map__card">
        <Show when={first()}>{(start) => <Show when={last()}>{(finish) => <div class="journey-map__bookends">
          <button type="button" onClick={() => choose(start())}><span class="journey-map__eyebrow"><i class="journey-map__dot journey-map__dot--start" />Start · {locationName(start())}</span><strong>{start().place.name}</strong></button>
          <span class="journey-map__arrow" aria-hidden="true">→</span>
          <button type="button" onClick={() => choose(finish())}><span class="journey-map__eyebrow"><i class="journey-map__dot journey-map__dot--finish" />{start().place.id === finish().place.id ? "Return" : "Finish"} · {locationName(finish())}</span><strong>{finish().place.name}</strong></button>
        </div>}</Show>}</Show>
        <div class="day-map__surface">
          <div class="day-map__canvas" ref={canvas} role="region" aria-label="Interactive day map" />
          <Show when={view()}><div class="journey-map__tools">
            <Show when={hasFlights()}><div class="journey-map__scope" role="group" aria-label="Map area"><button type="button" aria-pressed={!includeFlights()} onClick={() => showWholeDay(false)}>Ground route</button><button type="button" aria-pressed={includeFlights()} onClick={() => showWholeDay(true)}>Whole day</button></div></Show>
          </div></Show>
          <Show when={!nearby() || loading()}><p class="day-map__state" role="status">Loading map…</p></Show>
          <Show when={failed()}><div class="day-map__state" role="status"><Icon name="map" /><p>Couldn’t load the map.</p><button type="button" class="day-map__button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div></Show>
          <Show when={data().stops.length === 0}><p class="day-map__state">No mapped places for this day.</p></Show>
        </div>
        <Show when={selected()}>{(visit) => <div class="journey-map__selection" aria-live="polite">
          <span aria-hidden="true" class={`journey-map__badge journey-map__badge--${visit().kind}`}><StopIcon visit={visit()} /></span>
          <div class="journey-map__selected-copy"><p class="journey-map__eyebrow">{label(visit())}<Show when={visit().time}> · {visit().time}</Show><Show when={visit().place.rating}> · ★ {visit().place.rating}</Show></p><strong>{visit().place.name}</strong><p class="journey-map__category">{formatCategory(visit().place.category) ?? (visit().kind === "hotel" ? "Your stay" : "Planned stop")}</p></div>
          <a class="journey-map__directions" href={buildGoogleMapsUrl(visit().place)} target="_blank" rel="noopener noreferrer" aria-label={`Directions to ${visit().place.name}`}><Icon name="route" /><span>Directions</span></a>
          <a class="journey-map__place-link" href={buildGooglePlaceUrl(visit().place)} target="_blank" rel="noopener noreferrer">View place</a>
        </div>}</Show>
        <div class="journey-map__stops" ref={rail} role="group" aria-label="Day stops">
          <For each={visits()}>{(visit) => <button type="button" class="journey-map__stop" classList={{ "journey-map__stop--selected": visit.id === selected()?.id }} aria-pressed={visit.id === selected()?.id} onClick={() => choose(visit)}>
            <span aria-hidden="true" class={`journey-map__badge journey-map__badge--${visit.kind}`}><StopIcon visit={visit} /></span><span><small>{label(visit)}<Show when={visit.time}> · {visit.time}</Show></small><strong>{visit.place.name}</strong></span>
          </button>}</For>
        </div>
        <Show when={view()}><div class="day-map__legend"><For each={legend()}>{(mode) => <span><i class="day-map__line" style={{ "--map-line-colour": MAP_MODES[mode].colour }} />{MAP_MODES[mode].label}</span>}</For><Show when={data().paths.some((path) => path.approximate && path.mode !== "flight")}><span>Approximate connections shown dashed</span></Show><Show when={includeFlights() && hasFlights()}><span>Flights shown schematically</span></Show></div></Show>
      </div>
      <Show when={unavailable() && view()}><div class="day-map__notice" role="status"><p>Street map unavailable. Your route and stops are still shown.</p><button type="button" class="day-map__button" onClick={() => view()?.retry()}>Retry street map</button></div></Show>
      <Show when={data().missingPlaces}><p class="day-map__notice">Some stops have no map location.</p></Show>
    </section>
  );
}
