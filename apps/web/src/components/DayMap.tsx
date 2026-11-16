import { For, Show, type JSX, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import type { TripBundle } from "@travel-companion/trip-schema";
import type { DayRouting } from "../lib/day-routing";
import { MAP_MODES, buildDayMap, dayMapVisits, legInto, type DayMapView, type MapPath, type MapVisit } from "../lib/day-map";
import type { MapTheme } from "../lib/map-style";
import { formatDistance, formatDurationShort } from "../lib/format";
import { holdMapSnap } from "../lib/map-snap";
import { theme } from "../lib/theme";
import { TRAVEL_ICON_PATHS } from "../lib/travel-icons";
import { Icon } from "./Icon";

function StopIcon(props: { visit: MapVisit }) {
  const path = () => props.visit.kind === "poi" ? undefined : TRAVEL_ICON_PATHS[props.visit.kind === "hotel" ? "lodging" : props.visit.kind === "airport" ? "flight" : "transit"];
  return <Show when={path()} fallback={<span>{props.visit.label}</span>}><svg viewBox="0 0 16 16" aria-hidden="true"><path d={path()} /></svg></Show>;
}

/** The theme actually showing, following the system while the app's theme is "system". */
function useMapTheme(): () => MapTheme {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(query.matches);
  const onChange = () => setSystemDark(query.matches);
  query.addEventListener("change", onChange);
  onCleanup(() => query.removeEventListener("change", onChange));
  return () => {
    const chosen = theme();
    return chosen === "system" ? (systemDark() ? "dark" : "light") : chosen;
  };
}

/**
 * The Day map. Scrolling near it snaps it to fill the screen under the day
 * tabs (map mode): there one finger moves the map, and the step card steps
 * through the day leg by leg. Dragging the heading or the step card, or Done,
 * scrolls the page away and the map goes back to two-finger gestures.
 */
export function DayMap(props: {
  routing: DayRouting;
  bundle: TripBundle;
  stayPlaceIds: Set<string>;
  /** A stop as the Day route draws it: photo, hours, rating, notes. */
  renderStop: (visit: MapVisit) => JSX.Element;
  /** A leg as the Day route draws it, departure board included; undefined where there is no route leg. */
  renderLeg: (path: MapPath) => JSX.Element | undefined;
}) {
  let section!: HTMLElement;
  let canvas!: HTMLDivElement;
  const mapTheme = useMapTheme();
  const [nearby, setNearby] = createSignal(false);
  const data = createMemo(on(() => props.bundle.revision, () => untrack(() => buildDayMap(props.routing, props.bundle, props.stayPlaceIds))));
  const [view, setView] = createSignal<DayMapView>();
  /** The step on screen: a stop (`stop:<visit>`) or the leg arriving at one (`leg:<visit>`). */
  const [stepKey, setStepKey] = createSignal(`stop:${dayMapVisits(data(), false)[0]?.id ?? ""}`);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [unavailable, setUnavailable] = createSignal(false);
  const [engaged, setEngaged] = createSignal(false);
  const [snappable, setSnappable] = createSignal(false);
  const [snapRested, setSnapRested] = createSignal(false);
  const [includeFlights, setIncludeFlights] = createSignal(false);
  const [attempt, setAttempt] = createSignal(0);
  const visits = () => dayMapVisits(data(), includeFlights());
  const first = () => visits()[0];
  const last = () => visits().at(-1);
  type Step = { key: string; kind: "stop" | "leg"; visit: MapVisit; path?: MapPath };
  /** The day as steps: Start, then each leg followed by the stop it arrives at. */
  const steps = createMemo((): Step[] => visits().flatMap((visit, index) => {
    const stop: Step = { key: `stop:${visit.id}`, kind: "stop", visit };
    const path = index > 0 ? legInto(data(), visit.id, includeFlights()) : undefined;
    return path ? [{ key: `leg:${visit.id}`, kind: "leg", visit, path }, stop] : [stop];
  }));
  const stepIndex = () => Math.max(0, steps().findIndex((step) => step.key === stepKey()));
  const current = () => steps()[stepIndex()];
  /** The visit the current step is about: the stop, or where the leg arrives. */
  const selected = () => current()?.visit ?? first();
  const selectedIndex = () => visits().findIndex((visit) => visit.id === selected()?.id);
  const hasFlights = () => data().paths.some((path) => path.mode === "flight");
  const hasMap = () => data().stops.length > 0;
  const poiCount = () => new Set(visits().filter((visit) => visit.kind === "poi").map((visit) => visit.place.id)).size;
  const stopCount = () => Math.max(0, ...visits().map((visit) => Number(visit.label)).filter(Number.isFinite));
  const label = (visit: MapVisit) => visit.id === first()?.id ? "Start" : visit.id === last()?.id ? (visit.place.id === first()?.place.id ? "Return" : "Finish") : visit.kind === "hotel" ? "Hotel" : `Stop ${visit.label}`;

  onMount(() => {
    if (!("IntersectionObserver" in window)) { setNearby(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNearby(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(section);
    onCleanup(() => observer.disconnect());
  });

  // Map mode: on when the page has come to rest with the map snapped under the tabs.
  onMount(() => {
    const offset = () => section.getBoundingClientRect().top - (parseFloat(getComputedStyle(section).scrollMarginTop) || 0);
    const aligned = () => Math.abs(offset()) <= 4;
    /**
     * Only a day with a good screenful above its map snaps onto it. On a short
     * day the map is already in view, and a snap would pull the day's summary
     * off the screen the moment the day opens.
     */
    const measure = () => {
      const itinerary = document.querySelector(".itinerary")?.getBoundingClientRect().top ?? 0;
      setSnappable(hasMap() && section.getBoundingClientRect().top - itinerary > window.innerHeight * 0.6);
    };
    let settle: ReturnType<typeof setTimeout> | undefined;
    const settled = () => {
      measure();
      const on = hasMap() && aligned();
      setEngaged(on);
      // The snap is for coming in. Once in, it stands down, or a scroll away would be pulled straight back.
      if (on) setSnapRested(true);
    };
    const onScroll = () => {
      // Leaving is immediate, so the page never scrolls under a map that grabs one finger.
      if (engaged() && !aligned()) setEngaged(false);
      // Half a screen away, the next approach snaps again.
      if (snapRested() && Math.abs(offset()) > window.innerHeight * 0.5) setSnapRested(false);
      if (!("onscrollend" in window)) { clearTimeout(settle); settle = setTimeout(settled, 120); }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scrollend", settled);
    // The day above changes height as it folds, unfolds and loads photos.
    const resize = new ResizeObserver(measure);
    resize.observe(document.querySelector(".itinerary") ?? document.body);
    onCleanup(() => resize.disconnect());
    onCleanup(() => {
      clearTimeout(settle);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("scrollend", settled);
    });
  });
  createEffect(() => view()?.setInteractive(engaged()));
  createEffect(on(mapTheme, (next) => view()?.setTheme(next), { defer: true }));

  createEffect(on([nearby, data, attempt], ([visible, next]) => {
    if (!visible) return;
    setFailed(false);
    setUnavailable(false);
    setLoading(next.stops.length > 0);
    setIncludeFlights(false);
    setStepKey(`stop:${dayMapVisits(next, false)[0]?.id ?? ""}`);
    const controller = new AbortController();
    let mounted: DayMapView | undefined;
    onCleanup(() => { controller.abort(); mounted?.destroy(); setView(undefined); });
    if (!next.stops.length) return;
    const render = async () => {
      // MapLibre is large; it loads only when a Day map comes near the screen.
      const { mountMapLibreDayMap } = await import("../lib/maplibre-view");
      controller.signal.throwIfAborted();
      return mountMapLibreDayMap(canvas, next, untrack(mapTheme), (id) => choose(id), setUnavailable, controller.signal);
    };
    void render().then((ready) => {
      if (controller.signal.aborted) { ready.destroy(); return; }
      mounted = ready;
      setView(ready);
      setLoading(false);
      ready.setTheme(untrack(mapTheme));
      ready.setInteractive(untrack(engaged));
      // Again now the controls over the map exist, so the first view leaves room for them.
      requestAnimationFrame(() => { if (!controller.signal.aborted) { ready.fit(false); const start = dayMapVisits(next, false)[0]; if (start) ready.highlight(start.id); } });
    }).catch(() => {
      if (controller.signal.aborted) return;
      setLoading(false);
      setFailed(true);
    });
  }));

  /** The step strip: the card's other mode, every stop and leg in a row for jumping straight to one. */
  const [listing, setListing] = createSignal(false);
  /** Opened on the step you're on. */
  const centreStrip = (strip: HTMLDivElement) => requestAnimationFrame(() => {
    const chip = strip.children.item(stepIndex());
    if (chip instanceof HTMLElement) strip.scrollLeft = chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2;
  });

  /** Show a step: Start frames the whole day, a stop comes in close, a leg frames the way in. */
  const go = (key: string) => {
    const step = steps().find((candidate) => candidate.key === key);
    if (!step) return;
    setStepKey(step.key);
    if (step.kind === "leg") view()?.focusLeg(step.visit.id);
    else if (step.visit.id === first()?.id) { view()?.fit(includeFlights()); view()?.highlight(step.visit.id); }
    else view()?.focusStop(step.visit.id);
  };
  /** A pin: that stop. */
  const choose = (visitId: string) => go(`stop:${visitId}`);
  const jump = (key: string) => { setListing(false); go(key); };
  const step_ = (by: number) => {
    const next = steps()[stepIndex() + by];
    if (next) go(next.key);
  };
  const reset = () => setStepKey(`stop:${first()?.id ?? ""}`);
  const showWholeDay = (whole: boolean) => { setIncludeFlights(whole); reset(); view()?.fit(whole); if (first()) view()?.highlight(first()?.id ?? ""); };
  const fitDay = () => { reset(); view()?.fit(includeFlights()); if (first()) view()?.highlight(first()?.id ?? ""); };
  /** Out of map mode: scroll back up so the end of the day route shows above the map. */
  const leave = () => {
    holdMapSnap(1200);
    window.scrollBy({ top: -Math.round(window.innerHeight * 0.55), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };

  const placeName = (placeId: string) => props.bundle.places[placeId]?.name ?? "";
  /** A leg with no route leg to draw (a flight, a bare connection): what we can still say. */
  const legFallback = (path: MapPath) => [
    path.mode === "connection" ? "No route saved" : MAP_MODES[path.mode].label,
    formatDurationShort(path.durationSeconds),
    path.mode === "walking" ? formatDistance(path.distanceMetres) : undefined,
  ].filter(Boolean).join(" · ");
  /** The step header: where you are in the day. */
  const stepTitle = (step: Step) => {
    if (step.kind === "leg" && step.path) return `${placeName(step.path.fromPlaceId)} → ${step.visit.place.name}`;
    const name = label(step.visit);
    return name.startsWith("Stop") ? `${name} of ${stopCount()}` : name;
  };
  const legend = () => [...new Set(data().paths.filter((path) => includeFlights() || path.mode !== "flight").map((path) => path.mode))];
  const anyApproximate = () => data().paths.some((path) => path.approximate && path.mode !== "flight");
  const lineColour = (mode: keyof typeof MAP_MODES) => mapTheme() === "dark" ? MAP_MODES[mode].dark : MAP_MODES[mode].colour;

  return (
    <section class="day-map journey-map" classList={{ "day-map--live": hasMap(), "day-map--snap": snappable() && !snapRested(), "day-map--engaged": engaged() }} ref={section} aria-label="Day map">
      <div class="day-map__heading">
        <div><h3 class="day-part__label">Day map</h3><p class="journey-map__subheading">{new Set(visits().map((visit) => visit.place.id)).size} places<Show when={poiCount()}> · {poiCount()} {poiCount() === 1 ? "point of interest" : "points of interest"}</Show></p></div>
        <Show when={engaged()}><button type="button" class="day-map__button" onClick={leave}>Done</button></Show>
      </div>
      <div class="journey-map__card">
        <div class="day-map__surface">
          <div class="day-map__canvas" ref={canvas} role="region" aria-label="Interactive day map" />
          <Show when={view()}><div class="journey-map__tools" data-map-overlay="top">
            <Show when={hasFlights()}><div class="journey-map__scope" role="group" aria-label="Map area"><button type="button" aria-pressed={!includeFlights()} onClick={() => showWholeDay(false)}>Ground route</button><button type="button" aria-pressed={includeFlights()} onClick={() => showWholeDay(true)}>Whole day</button></div></Show>
            <button type="button" class="journey-map__fit" onClick={fitDay}><Icon name="map" /><span>Fit day</span></button>
          </div></Show>
          {/* Over the map's foot: the legend, then the step card (or the step strip). */}
          <Show when={view() && current()}><div class="journey-map__dock" data-map-overlay="bottom">
            <div class="day-map__legend" aria-label="Route lines">
              <For each={legend()}>{(mode) => <span><i class="day-map__line" style={{ "--map-line-colour": lineColour(mode) }} />{MAP_MODES[mode].label}</span>}</For>
              <Show when={anyApproximate()}><span><i class="day-map__line day-map__line--dashed" />Approximate</span></Show>
            </div>
            <div class="journey-map__step" classList={{ "journey-map__step--leg": current()?.kind === "leg" }}>
              <div class="journey-map__step-head">
                <button type="button" class="journey-map__step-button" aria-label="Previous step" disabled={stepIndex() <= 0} onClick={() => step_(-1)}>‹</button>
                <p class="journey-map__step-title" aria-live="polite">{current() ? stepTitle(current()!) : ""}</p>
                <button type="button" class="journey-map__step-button journey-map__step-button--list" aria-label={listing() ? "Back to the card" : "All stops and legs"} aria-pressed={listing()} onClick={() => setListing(!listing())}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d={listing() ? "M3 3h10v10H3Z" : "M2.5 4h11M2.5 8h11M2.5 12h11"} /></svg>
                </button>
                <button type="button" class="journey-map__step-button" aria-label="Next step" disabled={stepIndex() >= steps().length - 1} onClick={() => step_(1)}>›</button>
              </div>
              <Show when={!listing()} fallback={
                <div class="journey-map__stops" ref={centreStrip} role="group" aria-label="Day stops and legs">
                  <For each={steps()}>{(item) => <button type="button" class="journey-map__stop" classList={{ "journey-map__stop--leg": item.kind === "leg", "journey-map__stop--selected": item.key === current()?.key }} aria-pressed={item.key === current()?.key} aria-label={stepTitle(item)} onClick={() => jump(item.key)}>
                    <Show when={item.kind === "leg" && item.path} fallback={<><span aria-hidden="true" class={`journey-map__badge journey-map__badge--small journey-map__badge--${item.visit.kind}`}><StopIcon visit={item.visit} /></span><span class="journey-map__stop-name">{item.visit.place.name}</span></>}>
                      {(path) => <><svg class="journey-map__mode" viewBox="0 0 16 16" aria-hidden="true"><path d={TRAVEL_ICON_PATHS[path().mode === "connection" ? "transit" : path().mode] ?? ""} /></svg><span class="journey-map__stop-name">{formatDurationShort(path().durationSeconds) ?? MAP_MODES[path().mode].label}</span></>}
                    </Show>
                  </button>}</For>
                </div>
              }>
                {/* Keyed: each step draws its own card, so a photo or departure board never carries over. */}
                <Show when={current()} keyed>{(step) => <div class="journey-map__step-body">
                  {step.kind === "leg" && step.path
                    ? props.renderLeg(step.path) ?? <p class="journey-map__leg">{legFallback(step.path)}</p>
                    : props.renderStop(step.visit)}
                </div>}</Show>
              </Show>
            </div>
          </div></Show>
          <Show when={!nearby() || loading()}><p class="day-map__state" role="status">Loading map…</p></Show>
          <Show when={failed()}><div class="day-map__state" role="status"><Icon name="map" /><p>Couldn’t load the map.</p><button type="button" class="day-map__button" onClick={() => setAttempt((n) => n + 1)}>Try again</button></div></Show>
          <Show when={!hasMap()}><p class="day-map__state">No mapped places for this day.</p></Show>
        </div>
      </div>
      <Show when={unavailable() && view()}><div class="day-map__notice" role="status"><p>Street map unavailable. Your route and stops are still shown.</p><button type="button" class="day-map__button" onClick={() => view()?.retry()}>Retry street map</button></div></Show>
      <Show when={data().missingPlaces}><p class="day-map__notice">Some stops have no map location.</p></Show>
    </section>
  );
}
