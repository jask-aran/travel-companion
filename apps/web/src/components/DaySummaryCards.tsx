import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { FlightItem, Place } from "@travel-companion/trip-schema";
import type { FlightTiming } from "../lib/day-times";
import { formatDayHeading, formatDurationShort } from "../lib/format";
import type { EarlyStart } from "../lib/tomorrow";
import { closesAt, hoursOn, minutesOf, noteHasWords, type DayNote, type DayStop, type TimedPlace } from "../lib/day-insights";
import { useMapTheme } from "../lib/map-theme";
import { SNAPSHOT_PADDING, mapAreas } from "../lib/map-areas";
import { selection } from "../lib/haptics";
import type { SnapshotLine, SnapshotStop } from "../lib/map-snapshot";
import { notesPreview } from "../lib/rich-notes";
import { Icon } from "./Icon";
import { RichNotes } from "./RichNotes";
import { FlightRow, ModeGlyph, usePlacePhoto } from "./ItemCards";

/**
 * The Day summary's cards for what a day holds besides its long journeys:
 * the plan's times, places, fixed maps of each block of exploring, opening
 * hours and your notes, and for a day with nothing planned, what you have to
 * work with. Each is worked out from the trip by rules (lib/day-insights.ts).
 */

/** Asks the Day map to open on a stop (DayMap listens). */
export const SHOW_STOP_EVENT = "trip:show-stop";
const showOnMap = (itemId: string) => window.dispatchEvent(new CustomEvent(SHOW_STOP_EVENT, { detail: { itemId } }));

/**
 * The plan's times in one line: up to three as written ("07:00 Nagoya Station
 * · 09:00–17:00 Suzuka Circuit"), or the first and last with a count between.
 */
export function DayTimesLine(props: { times: TimedPlace[] }) {
  const shown = () => (props.times.length <= 3 ? props.times : [props.times[0]!, props.times.at(-1)!]);
  return (
    <p class="day-times with-icon">
      <Icon name="clock" />
      <span>
        <For each={shown()}>
          {(entry, index) => (
            <>
              <Show when={index() > 0}>{props.times.length > 3 ? ` · ${props.times.length - 2} more · ` : " · "}</Show>
              <strong>{entry.time}</strong> {entry.name}
            </>
          )}
        </For>
      </span>
    </p>
  );
}

/** A lone stop between two journeys, named, with its planned time. */
export function BlockStopsLine(props: { stops: DayStop[] }) {
  const time = (stop: DayStop) => {
    const { startTime, endTime } = stop.item;
    return startTime ? `${startTime}${endTime && endTime !== startTime ? `–${endTime}` : ""}` : undefined;
  };
  return (
    <p class="day-summary__between day-summary__between--named with-icon">
      <Icon name="pin" />
      <span>
        <For each={props.stops}>
          {(stop, index) => (
            <>
              <Show when={index() > 0}>{" · "}</Show>
              <span class="day-summary__stop">{stop.place.name}</span>
              <Show when={time(stop)}>{(value) => <> <strong>{value()}</strong></>}</Show>
            </>
          )}
        </For>
      </span>
    </p>
  );
}

/** A note's text, with its links as links named by their site. */
/** One note as Wanderlog wrote it, cut short past about six lines with "Show all". */
function NoteBody(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  const [long, setLong] = createSignal(false);
  let box!: HTMLDivElement;
  onMount(() => {
    // Measured once laid out: a folded section has no height until opened.
    const observer = new ResizeObserver(() => {
      if (!open()) setLong(box.scrollHeight > box.clientHeight + 2);
    });
    observer.observe(box);
    onCleanup(() => observer.disconnect());
  });
  return (
    <div class="day-notes__text">
      <div ref={box} classList={{ "day-notes__clamp": !open() && long(), "day-notes__measure": !open() }}>
        <RichNotes text={props.text} />
      </div>
      <Show when={long()}>
        <button type="button" class="day-notes__more" onClick={() => { selection(); setOpen(!open()); }}>
          {open() ? "Show less" : "Show all"}
        </button>
      </Show>
    </div>
  );
}

function PlaceTile(props: { stop: DayStop }) {
  const photo = usePlacePhoto(() => props.stop.place);
  return (
    <button type="button" class="place-tile" data-haptic="selection" aria-label={`${props.stop.place.name}, stop ${props.stop.order}: show on the Day map`} onClick={() => showOnMap(props.stop.item.id)}>
      <span class="place-tile__photo">
        <Show when={!photo.failed() && photo.url()}>{(src) => <img src={src()} alt="" loading="lazy" decoding="async" onLoad={photo.onLoad} onError={photo.fail} />}</Show>
        <b>{props.stop.order}</b>
        <Show when={photo.credit() && !photo.failed()}>{(credit) => <small class="place-tile__credit">{credit()}</small>}</Show>
      </span>
      <span class="place-tile__name">{props.stop.place.name}</span>
    </button>
  );
}

/** The day's places to visit as small photo tiles, in route order; a tile opens the stop on the Day map. */
export function PlacesStrip(props: { stops: DayStop[] }) {
  return (
    <div class="places-strip">
      <p class="summary-label">Places <small>{props.stops.length} today</small></p>
      <div class="places-strip__row" role="group" aria-label="Today's places">
        <For each={props.stops}>{(stop) => <PlaceTile stop={stop} />}</For>
      </div>
    </div>
  );
}

const MINI_MAP_HEIGHT = 150;

/** The town most of an area's stops are in. */
function areaName(stops: SnapshotStop[]): string | undefined {
  const counts = new Map<string, number>();
  for (const stop of stops) if (stop.area) counts.set(stop.area, (counts.get(stop.area) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
const stopCount = (n: number) => `${n} ${n === 1 ? "stop" : "stops"}`;

/**
 * A fixed map of a group of stops: fitted to them, and not movable. A still
 * image, drawn when it comes near the screen and again when the theme changes.
 * Stops too spread out to tell apart in one view are split into areas
 * (lib/map-areas.ts), and ‹ › step between them.
 */
export function MiniMap(props: { stops: SnapshotStop[]; lines: SnapshotLine[]; label: string; caption?: string; zoom?: number }) {
  let figure!: HTMLElement;
  const theme = useMapTheme();
  const [near, setNear] = createSignal(false);
  const [width, setWidth] = createSignal(0);
  const [src, setSrc] = createSignal<string>();
  onMount(() => {
    // Drawn at a rounded width, so a few pixels of layout don't redraw it.
    const measure = () => setWidth(Math.round(figure.clientWidth / 20) * 20);
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(figure);
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, { rootMargin: "300px" });
    observer.observe(figure);
    onCleanup(() => { observer.disconnect(); resize.disconnect(); });
  });
  const shape = () => JSON.stringify([props.stops, props.lines, props.zoom]);
  /** Areas need the drawn width: they depend on how far apart the pins land. */
  const areas = createMemo(() => (width() ? mapAreas(props.stops, width(), MINI_MAP_HEIGHT, SNAPSHOT_PADDING) : [props.stops.map((_, index) => index)]));
  const [step, setStep] = createSignal(0);
  createEffect(on(areas, () => setStep(0), { defer: true }));
  const area = () => areas()[Math.min(step(), areas().length - 1)] ?? [];
  const request = (mapTheme: "light" | "dark", w: number, index: number) => {
    const many = areas().length > 1;
    return { theme: mapTheme, width: w, height: MINI_MAP_HEIGHT, stops: props.stops, lines: props.lines, ...(props.zoom ? { zoom: props.zoom } : {}), ...(many ? { fit: areas()[index] } : {}) };
  };
  createEffect(on([near, theme, width, shape, step], ([visible, mapTheme, w, , index]) => {
    if (!visible || !w) return;
    let live = true;
    onCleanup(() => { live = false; });
    void import("../lib/map-snapshot")
      .then(async ({ mapSnapshot }) => {
        const image = await mapSnapshot(request(mapTheme, w, index));
        if (live) setSrc(image);
        // The next area, ready before it is asked for.
        if (index + 1 < areas().length) void mapSnapshot(request(mapTheme, w, index + 1)).catch(() => undefined);
      })
      .catch(() => undefined);
  }));
  const go = (by: number) => {
    const next = step() + by;
    if (next < 0 || next >= areas().length) return;
    selection();
    setStep(next);
  };
  const stopsOf = (indexes: number[]) => indexes.map((index) => props.stops[index]).filter((stop): stop is SnapshotStop => stop !== undefined);
  /** The town, or where two areas share a town, the area's first stop. */
  const areaLabel = () => {
    const stops = stopsOf(area());
    const town = areaName(stops);
    const shared = town && areas().filter((other) => areaName(stopsOf(other)) === town).length > 1;
    const name = shared || !town ? stops[0]?.name : town;
    return `${name ? `${name} · ` : ""}${stopCount(stops.length)}`;
  };
  return (
    <figure class="mini-map" ref={figure} style={{ height: `${MINI_MAP_HEIGHT}px` }}>
      <Show when={src()}>{(image) => <img src={image()} alt={props.label} />}</Show>
      <Show
        when={areas().length > 1}
        fallback={<Show when={props.caption}>{(caption) => <figcaption class="with-icon"><Icon name="pin" />{caption()}</figcaption>}</Show>}
      >
        <figcaption class="mini-map__areas">
          <button type="button" aria-label="Previous area" disabled={step() === 0} onClick={() => go(-1)}>‹</button>
          <span aria-live="polite">{areaLabel()} <small>{step() + 1} of {areas().length}</small></span>
          <button type="button" aria-label="Next area" disabled={step() === areas().length - 1} onClick={() => go(1)}>›</button>
        </figcaption>
      </Show>
      <span class="mini-map__credit">© OpenStreetMap</span>
    </figure>
  );
}

/** Every stop's hours on one clock, folded to a line until opened. */
export function HoursFold(props: { stops: DayStop[]; weekday: number; sunset: string | undefined }) {
  const rows = () => props.stops.map((stop) => ({ stop, hours: hoursOn(stop.place, props.weekday) }));
  const closes = () => rows().map((row) => closesAt(row.hours)).filter((close): close is number => close !== undefined);
  const earliest = () => (closes().length ? Math.min(...closes()) : undefined);
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  // The clock spans the day's hours, at least 06:00 to 19:00.
  const range = () => {
    const opens = rows().flatMap((row) => (row.hours.kind === "open" ? row.hours.windows.map((window) => window.open) : []));
    const low = Math.min(6 * 60, ...opens.map((open) => Math.floor(open / 60) * 60));
    const high = Math.max(19 * 60, ...closes().map((close) => Math.min(24 * 60, Math.ceil(close / 60) * 60)));
    return { low, high };
  };
  const at = (minutes: number) => `${Math.max(0, Math.min(100, ((minutes - range().low) / (range().high - range().low)) * 100)).toFixed(1)}%`;
  const ticks = () => {
    const out: number[] = [];
    for (let hour = Math.ceil(range().low / 180) * 3; hour * 60 <= range().high; hour += 3) out.push(hour * 60);
    return out;
  };
  return (
    <details class="summary-fold">
      <summary>
        <span class="summary-label">Opening hours</span>
        <span class="summary-fold__hint">{props.stops.length} stops · {earliest() !== undefined ? `earliest close ${clock(earliest()!)}` : "no hours listed"}</span>
      </summary>
      <div class="hours-clock">
        <For each={rows()}>
          {(row) => (
            <>
              <span class="hours-clock__name"><b>{row.stop.order}</b>{row.stop.place.name}</span>
              <span class="hours-clock__track">
                <Show when={row.hours.kind === "open" && row.hours} fallback={<i class="hours-clock__bar" classList={{ "hours-clock__bar--always": row.hours.kind === "always", "hours-clock__bar--none": row.hours.kind === "unknown", "hours-clock__bar--closed": row.hours.kind === "closed" }} style={{ left: "0", right: "0" }} />}>
                  {(open) => <For each={open().windows}>{(window) => <i class="hours-clock__bar" style={{ left: at(window.open), right: `calc(100% - ${at(window.close ?? range().high)})` }} />}</For>}
                </Show>
                <Show when={props.sunset}>{(sunset) => <i class="hours-clock__sun" style={{ left: at(minutesOf(sunset())) }} />}</Show>
                <Show when={row.stop.item.startTime}>{(start) => <i class="hours-clock__plan" style={{ left: at(minutesOf(start())) }} />}</Show>
              </span>
            </>
          )}
        </For>
        <span />
        <span class="hours-clock__axis"><For each={ticks()}>{(tick) => <span style={{ left: at(tick) }}>{String(tick / 60).padStart(2, "0")}</span>}</For></span>
        <p class="hours-clock__key">
          <span><i class="hours-clock__bar" />Open</span>
          <span><i class="hours-clock__bar hours-clock__bar--always" />Always open</span>
          <Show when={props.sunset}><span><i class="hours-clock__sun" />Sunset {props.sunset}</span></Show>
          <Show when={props.stops.some((stop) => stop.item.startTime)}><span><i class="hours-clock__plan" />Your planned time</span></Show>
        </p>
      </div>
    </details>
  );
}

/**
 * Your notes for the day in one place. Folded to one line, led by the first
 * note with words in it (not a bare link), unless `open`: on a day with little
 * else planned, the notes are the plan.
 */
export function NotesFold(props: { notes: DayNote[]; open?: boolean }) {
  const lead = () => props.notes.find((note) => noteHasWords(note.text)) ?? props.notes[0];
  // A bare link reads as its site in the one-line hint.
  const leadText = () => notesPreview(lead()?.text ?? "").replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/g, "$1");
  return (
    <details class="summary-fold" open={props.open}>
      <summary>
        <span class="summary-label">Your notes</span>
        <span class="summary-fold__hint">{props.notes.length} · {leadText()}</span>
      </summary>
      <ul class="day-notes">
        <For each={props.notes}>
          {(note) => (
            <li>
              <b>{note.order ?? "✎"}</b>
              <NoteBody text={note.text} />
              <span class="day-notes__where">{note.stop ?? (note.after ? `After ${note.after}` : "Before the first stop")}</span>
            </li>
          )}
        </For>
      </ul>
    </details>
  );
}

/** A day with nothing planned: the streets around your stay, other places in the same city, and the plan in Wanderlog. */
export function FreeDay(props: { stay: Place | undefined; others: { name: string; when: string }[]; wanderlogUrl: string | undefined; city: string | undefined }) {
  return (
    <div class="free-day">
      <Show when={props.stay?.latitude !== undefined && props.stay?.longitude !== undefined && props.stay}>
        {(stay) => <MiniMap stops={[{ lat: stay().latitude!, lng: stay().longitude!, label: "H", hotel: true }]} lines={[]} zoom={14.5} label={`Street map around ${stay().name}`} />}
      </Show>
      <Show when={props.others.length}>
        <p>Also in {props.city ?? "this city"}: {props.others.map((other) => `${other.name}, ${other.when}`).join("; ")}</p>
      </Show>
      <Show when={props.wanderlogUrl}>{(href) => <a class="free-day__link" href={href()} target="_blank" rel="noopener noreferrer">Open the trip in Wanderlog</a>}</Show>
    </div>
  );
}

/**
 * A flight in the Day summary, drawn as a departures board on the journey
 * rail: "06:15 MEL ✈ CNS 08:30", the flight and when to be at the airport
 * beneath. Tapping opens the full card (FlightRow), booking included. A
 * connection from the flight before starts with its layover.
 */
export function SummaryFlight(props: {
  item: FlightItem;
  timing?: FlightTiming | undefined;
  leaveLabel?: string | undefined;
  /** Minutes on the ground since the flight before, at this one's airport. */
  layover?: number | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  const code = () =>
    (props.item.flightNumber ? `${props.item.airlineCode ?? ""}${props.item.flightNumber}` : props.item.airline) || "Flight";
  const overnight = () => Boolean(props.item.departDate && props.item.arriveDate && props.item.arriveDate !== props.item.departDate);
  const toggle = () => {
    selection();
    setOpen(!open());
  };
  return (
    <>
      <ol class="day-summary__transfer">
        <Show when={props.layover}>
          {(minutes) => (
            <li class="flight-layover">
              <span class="flight-layover__pill">
                <Icon name="hourglass" />
                {formatDurationShort(minutes() * 60)}
                <span class="flight-layover__at">{props.item.departAirport}</span>
              </span>
            </li>
          )}
        </Show>
        <li class="travel travel--flight travel--long flight-line">
          <button
            type="button"
            class="travel__inner flight-line__button"
            aria-expanded={open()}
            aria-label={`${props.item.airline ?? "Flight"} ${code()}, ${props.item.departAirport ?? ""} ${props.item.departTime ?? ""} to ${props.item.arriveAirport ?? ""} ${props.item.arriveTime ?? ""}: ${open() ? "hide" : "show"} the booking`}
            onClick={toggle}
          >
            <span class="travel__glyph">
              <ModeGlyph mode="flight" />
            </span>
            <span class="flight-line__body" aria-hidden="true">
              <span class="flight-line__board">
                <strong>{props.item.departTime ?? "—"}</strong>
                <span class="flight-line__code">{props.item.departAirport}</span>
                <span class="flight-line__path" />
                <span class="flight-line__code">{props.item.arriveAirport}</span>
                <strong>
                  {props.item.arriveTime ?? "—"}
                  <Show when={overnight()}>
                    <sup class="flight-end__plus">+1</sup>
                  </Show>
                </strong>
              </span>
              <span class="flight-line__meta">
                <span>{code()}</span>
                <Show when={props.timing}>
                  {(timing) => (
                    <span class="with-icon" title={`At the airport by ${timing().airportBy}`}>
                      <Icon name="clock" />
                      {timing().airportBy}
                    </span>
                  )}
                </Show>
                <Show when={props.leaveLabel && props.timing?.leaveBy}>
                  {(leaveBy) => (
                    <span>
                      {props.leaveLabel} {leaveBy()}
                    </span>
                  )}
                </Show>
              </span>
            </span>
          </button>
        </li>
      </ol>
      <Show when={open()}>
        <ol class="day-summary__flights">
          <FlightRow item={props.item} timing={props.timing} leaveLabel={props.leaveLabel} />
        </ol>
      </Show>
    </>
  );
}

/** Tomorrow's early start, at the end of tonight's summary: "04:30 Leave Stay in Nipponbashi for…". */
export function TomorrowLine(props: { start: EarlyStart }) {
  return (
    <p class="tomorrow">
      <span class="summary-label">Tomorrow · {formatDayHeading(props.start.date)}</span>
      <strong class="tomorrow__time">{props.start.time}</strong>
      <span class="tomorrow__text">
        {props.start.text}
        <Show when={props.start.detail}>{(detail) => <span class="tomorrow__detail">, {detail()}</span>}</Show>
      </span>
    </p>
  );
}
