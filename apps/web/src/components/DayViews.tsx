import { Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import type { DayView } from "../lib/day-view";
import { selection } from "../lib/haptics";

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * A day's two views side by side, the Day summary and the Full Day Route:
 * swipe between them, or tap the switch above. The views sit in a sideways
 * scroller that snaps to each, so the swipe is the browser's own. The
 * scroller is as tall as the view in front, and while it moves its height
 * slides between the two, so the page below opens or closes with the swipe.
 *
 * The route mounts the first time it is asked for (a tap, or a finger on the
 * scroller), so a day only ever looked at as a summary costs no route.
 */
export function DayViews(props: {
  view: DayView;
  onView: (view: DayView) => void;
  summary: () => JSX.Element;
  route: () => JSX.Element;
  /** "16 stops", beside the route's tab. */
  routeHint?: string | undefined;
  /** For the header buttons that open the route. */
  routeId: string;
}) {
  const [routeMounted, setRouteMounted] = createSignal(props.view === "route");
  const [progress, setProgress] = createSignal(props.view === "route" ? 1 : 0);
  let track!: HTMLDivElement;
  let summaryPane!: HTMLElement;
  let routePane!: HTMLElement;
  const heights = { summary: 0, route: 0 };

  const fit = () => {
    const p = progress();
    track.style.height = `${heights.summary + (heights.route - heights.summary) * p}px`;
  };
  const span = () => Math.max(1, track.scrollWidth - track.clientWidth);
  const scrollTo = (view: DayView, smooth: boolean) => {
    track.scrollTo({ left: view === "route" ? span() : 0, behavior: smooth && !reducedMotion() ? "smooth" : "instant" });
  };

  /** Where the scroller came to rest decides the view. */
  const settle = () => {
    const view: DayView = progress() > 0.5 ? "route" : "summary";
    if (view !== props.view) {
      selection();
      props.onView(view);
    }
  };

  onMount(() => {
    const observer = new ResizeObserver(() => {
      heights.summary = summaryPane.offsetHeight;
      heights.route = routePane.offsetHeight;
      fit();
    });
    observer.observe(summaryPane);
    observer.observe(routePane);
    // Back on a day left on its route: there already, no slide.
    if (props.view === "route") requestAnimationFrame(() => scrollTo("route", false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      setProgress(Math.min(1, Math.max(0, track.scrollLeft / span())));
      fit();
      // `scrollend` where the browser has it; a pause in scrolling elsewhere.
      if (!("onscrollend" in window)) {
        clearTimeout(timer);
        timer = setTimeout(settle, 140);
      }
    };
    track.addEventListener("scroll", onScroll, { passive: true });
    track.addEventListener("scrollend", settle);
    onCleanup(() => {
      observer.disconnect();
      clearTimeout(timer);
      track.removeEventListener("scroll", onScroll);
      track.removeEventListener("scrollend", settle);
    });
  });

  // The header's route button, or the day header, can change the view too.
  createEffect(
    on(
      () => props.view,
      (view) => {
        if (view === "route") setRouteMounted(true);
        const at: DayView = progress() > 0.5 ? "route" : "summary";
        if (at !== view) requestAnimationFrame(() => scrollTo(view, true));
      },
      { defer: true },
    ),
  );

  const choose = (view: DayView) => {
    if (view === "route") setRouteMounted(true);
    selection();
    props.onView(view);
  };

  return (
    <div class="day-views" style={{ "--view-progress": String(progress()) }}>
      <div class="day-views__switch" role="tablist" aria-label="Day views">
        <button
          type="button"
          role="tab"
          class="day-views__tab"
          aria-selected={props.view === "summary"}
          onClick={() => choose("summary")}
        >
          Day summary
        </button>
        <button
          type="button"
          role="tab"
          class="day-views__tab"
          aria-selected={props.view === "route"}
          aria-controls={props.routeId}
          onClick={() => choose("route")}
        >
          Full Day Route
          <Show when={props.routeHint}>{(hint) => <span class="day-views__hint">{hint()}</span>}</Show>
        </button>
        <span class="day-views__indicator" aria-hidden="true" />
      </div>
      <div class="day-views__track" ref={track} onPointerDown={() => setRouteMounted(true)} onTouchStart={() => setRouteMounted(true)}>
        <section ref={summaryPane} class="day-views__pane" role="tabpanel" aria-label="Day summary" inert={props.view !== "summary"}>
          {props.summary()}
        </section>
        <section ref={routePane} class="day-views__pane" role="tabpanel" aria-label="Full Day Route" id={props.routeId} inert={props.view !== "route"}>
          <Show when={routeMounted()}>{props.route()}</Show>
        </section>
      </div>
    </div>
  );
}
