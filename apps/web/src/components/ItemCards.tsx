import { TRAVEL_ICON_PATHS } from "../lib/travel-icons";
import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js";
import type {
  DepartureBoard,
  DepartureOption,
  DepartureSegment,
  DayItem,
  FlightItem,
  LodgingItem,
  NoteItem,
  Place,
  PlaceItem,
  RouteLeg,
  TripBundle,
} from "@travel-companion/trip-schema";
import {
  areaOf,
  formatArrows,
  formatDistance,
  formatCategory,
  formatDuration,
  formatDurationShort,
  formatTabDayMonth,
  formatRatingLabel,
  formatOpeningForDay,
  formatTravelMode,
  nightsBetween,
  noteRestatesNames,
} from "../lib/format";
import { notesPreview } from "../lib/rich-notes";
import { pickDeparture } from "../lib/departure-pick";
import { RichNotes } from "./RichNotes";
import { buildGoogleMapsUrl, buildGooglePlaceUrl, buildLegDirectionsUrl } from "../lib/maps";
import { findPlacePhoto, hasNamedPhoto, markMediaFailed, mediaFailed, photoAttribution, placePhotoUrl, staticMapUrl, type PhotoFound } from "../lib/place-photo";
import { LONG_LEG_SECONDS } from "../lib/route-legs";
import { stayDisplay } from "../lib/lodging";
import type { FlightTiming } from "../lib/day-times";
import { Hidden, Icon } from "./Icon";
import { success } from "../lib/haptics";

function StatusPill(props: { status?: DayItem["status"] | undefined }) {
  return (
    <Show when={props.status && props.status !== "confirmed"}>
      <span class={`status-pill status-pill--${props.status}`}>{props.status}</span>
    </Show>
  );
}

function TimeLabel(props: { start?: string | undefined; end?: string | undefined }) {
  // Wanderlog often repeats the start time as the end time; show one value then.
  const end = () => (props.end && props.end !== props.start ? props.end : undefined);
  return (
    <Show when={props.start || end()}>
      <time class="item-time">
        {props.start}
        <Show when={props.start && end()}>
          <span class="item-time__sep">–</span>
        </Show>
        {end()}
      </time>
    </Show>
  );
}


function ModeGlyph(props: { mode: string }) {
  return (
    <svg class="mode-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d={TRAVEL_ICON_PATHS[props.mode] ?? TRAVEL_ICON_PATHS.walking} />
    </svg>
  );
}

/** When a ride leaves and arrives; an estimate is shown with a "~". */
export type RideTimes = { depart: string; arrive: string; approximate: boolean };

/**
 * Travel between two stops. An hour or more is a haul, drawn taller so a long
 * transfer feels long when you scroll past it.
 */
export function RouteLegRow(props: {
  leg: RouteLeg;
  places: TripBundle["places"];
  /** Names an end not listed beside it, like "from <hotel>". */
  note?: string | undefined;
  /**
   * Name both ends on a line of their own: for a journey shown in the
   * summary, where no stop beside it says where it runs.
   */
  showEnds?: boolean;
  /** Departure times fetched for this leg, shown beneath it. */
  board?: DepartureBoard | undefined;
  /** When the ride before gets you to this leg's start (see departure-pick). */
  notBefore?: string | undefined;
  /** The train or bus taken, where a board knows it: names the leg and colours it. */
  ride?: DepartureOption | undefined;
  /** When the ride runs, where a timed plan fixes it; stands in for the duration. */
  times?: RideTimes | undefined;
}) {
  const long = () => (props.leg.durationSeconds ?? 0) >= LONG_LEG_SECONDS;

  const transit = () => props.leg.travelMode === "transit";
  /** In its line's own colour, as the station signs have it. */
  const colour = () => (transit() ? lineColour(props.ride) : undefined);

  /** In the route: how long, then how far on foot or by car. A board beneath names the line. */
  const detail = () =>
    [
      formatDurationShort(props.leg.durationSeconds),
      transit() ? undefined : formatDistance(props.leg.distanceMetres),
      props.note,
    ]
      .filter(Boolean)
      .join(" · ");

  /** In the summary, under the two ends: what the lead line didn't say. */
  const aside = () =>
    [transit() ? undefined : formatDistance(props.leg.distanceMetres), props.note].filter(Boolean).join(" · ");

  /** Tapping a leg opens that hop, previous stop to next, in its own mode. */
  const directions = () => {
    const from = props.places[props.leg.fromPlaceId];
    const to = props.places[props.leg.toPlaceId];
    return from && to ? buildLegDirectionsUrl(from, to, props.leg.travelMode) : undefined;
  };

  const contents = () => (
    <>
      <span class="travel__glyph">
        <ModeGlyph mode={props.leg.travelMode} />
      </span>
      {/* The glyph names the mode; the word stays for screen readers. */}
      <span class="travel__mode visually-hidden">{formatTravelMode(props.leg.travelMode)}</span>
      <Show
        when={props.showEnds}
        fallback={
          <Show when={detail()}>
            <span class="travel__detail">{detail()}</span>
          </Show>
        }
      >
        {/* Read as the departure board under a route leg reads: when, then
            what you ride; the two ends beneath. */}
        <span class="travel__text">
          <span class="travel__lead">
            <span class="travel__times">
              <Show when={props.times} fallback={formatDurationShort(props.leg.durationSeconds)}>
                {(times) => (
                  <>
                    {times().approximate ? "~" : ""}
                    <strong>{times().depart}</strong>
                    <span class="travel__arrow">→</span>
                    {times().arrive}
                  </>
                )}
              </Show>
            </span>
            <Show when={transit() && props.ride}>{(ride) => <LineChips option={ride()} />}</Show>
          </span>
          <span class="travel__ends">
            {props.places[props.leg.fromPlaceId]?.name} → {props.places[props.leg.toPlaceId]?.name}
          </span>
          <Show when={aside()}>
            <span class="travel__detail">{aside()}</span>
          </Show>
        </span>
      </Show>
    </>
  );

  const label = () =>
    `${formatTravelMode(props.leg.travelMode)} directions, ${props.places[props.leg.fromPlaceId]?.name} to ${
      props.places[props.leg.toPlaceId]?.name
    }`;

  return (
    <li
      class={`travel travel--${props.leg.travelMode}`}
      classList={{ "travel--long": long(), "travel--lined": Boolean(colour()) }}
      style={colour() ? { "--line": colour()!.line, "--on-line": colour()!.on } : undefined}
    >
      {/* A leg with departures is one row drawn by its board: when, what you
          ride, a button for the timetable and one for Maps. */}
      <Show
        when={!props.showEnds && props.board}
        fallback={
          <Show when={directions()} fallback={<div class="travel__inner">{contents()}</div>}>
            {(href) => (
              <a
                class="travel__inner travel__link"
                href={href()}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={label()}
              >
                {contents()}
                <span class="travel__open">
                  <Icon name="map" />
                </span>
              </a>
            )}
          </Show>
        }
      >
        {(board) => (
          <DepartureBoardView
            board={board()}
            notBefore={props.notBefore}
            mode={props.leg.travelMode}
            mapsHref={directions()}
            mapsLabel={label()}
          />
        )}
      </Show>
    </li>
  );
}

const clockMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Minutes from one clock time to a later one, wrapping past midnight. */
const minutesBetween = (from: string, to: string) => (clockMinutes(to) - clockMinutes(from) + 1440) % 1440;

/**
 * How often a service runs, from the gaps between its departures on the
 * board: "every ~8 min". Needs three departures to say anything.
 */
function frequencyOf(options: DepartureOption[], service: string | undefined): number | undefined {
  if (!service) return undefined;
  const times = options
    .filter((option) => option.segments[0]?.name === service)
    .map((option) => clockMinutes(option.departTime));
  if (times.length < 3) return undefined;
  const gaps = times.slice(1).map((time, index) => time - times[index]!).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** "Skyliner › Oedo Line": the lines ridden, in order; one line changed onto itself is named once. */
export const chainOf = (option: DepartureOption) =>
  option.segments
    .map((segment) => segment.name)
    .filter((name, index, names) => name !== names[index - 1])
    .join(" › ");

/**
 * The colour a leg is drawn in: that of the ride that carries most of it,
 * with ink that reads on it (dark on the Ginza line's yellow, light on the
 * Chuo line's orange). Only six-digit hex colours are trusted.
 */
function lineColour(option: DepartureOption | undefined): { line: string; on: string } | undefined {
  const longest = option?.segments
    .filter((segment) => /^#[0-9a-f]{6}$/i.test(segment.color ?? ""))
    .sort(
      (a, b) => minutesBetween(b.departTime, b.arriveTime) - minutesBetween(a.departTime, a.arriveTime),
    )[0];
  const line = longest?.color;
  if (!line) return undefined;
  const [red, green, blue] = [1, 3, 5].map((at) => {
    const channel = parseInt(line.slice(at, at + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  // Whichever of near-black and near-white contrasts more with the line.
  return { line, on: luminance > 0.179 ? "#0b1f33" : "#fffaf0" };
}

/** The lines an option rides, in order, each as a chip; one line changed onto itself is named once. */
function LineChips(props: { option: DepartureOption }) {
  const segments = () =>
    props.option.segments.filter((segment, index, all) => segment.name !== all[index - 1]?.name);
  return (
    <span class="line-chips">
      <For each={segments()}>{(segment) => <LineChip segment={segment} />}</For>
    </span>
  );
}

/** A line's name edged in its own colour, as station signs use it. */
function LineChip(props: { segment: DepartureSegment }) {
  return (
    <span
      class={`departure__line departure__line--${props.segment.kind}`}
      title={props.segment.nameLocal}
      style={props.segment.color ? { "--line": props.segment.color } : undefined}
    >
      {props.segment.name}
    </span>
  );
}

/**
 * One way through, drawn as a line: a dot at each station, the rail between
 * in the line's colour. The station is the bold thing, since it is what you
 * look for on the platform; the line and where it is headed (what the signs
 * show) sit under it, how long the ride is at the row's end. A timetabled
 * option gives clock times; an untimed one gives each ride's typical length.
 */
function DepartureSteps(props: { option: DepartureOption; timed: boolean }) {
  const last = () => props.option.segments.at(-1);
  const lineOf = (segment: DepartureSegment | undefined) =>
    segment?.color ? { "--line": segment.color } : undefined;
  return (
    <ol class="departure-steps" classList={{ "departure-steps--untimed": !props.timed }}>
      <For each={props.option.segments}>
        {(segment, index) => {
          const previous = () => props.option.segments[index() - 1];
          const wait = () => previous() && minutesBetween(previous()!.arriveTime, segment.departTime);
          /** A walk between stations, e.g. Keisei Ueno to Ueno-Okachimachi. */
          const walks = () => Boolean(previous()?.to && segment.from && segment.from !== previous()!.to);
          const station = () => segment.from ?? previous()?.to;
          const riding = () => formatDurationShort(minutesBetween(segment.departTime, segment.arriveTime) * 60);
          return (
            <>
              <Show when={previous()}>
                {(before) => (
                  <li class="departure-steps__change">
                    {walks() ? `Change at ${before().to}, walk` : "Change"}
                    <Show when={props.timed && wait()}>{(minutes) => ` · ${minutes()} min`}</Show>
                  </li>
                )}
              </Show>
              <li class="departure-steps__ride" style={lineOf(segment)}>
                <span class="departure-steps__time">{props.timed ? segment.departTime : `~${riding()}`}</span>
                <span class="departure-steps__what">
                  <span class="departure-steps__station">
                    <span>{station() ?? "Board"}</span>
                    <Show when={props.timed}>
                      <span class="departure-steps__dur">{riding()}</span>
                    </Show>
                  </span>
                  <span class="departure-steps__sub">
                    <LineChip segment={segment} />
                    <Show when={segment.headsign}>
                      {(headsign) => <span class="departure-steps__where">towards {headsign()}</span>}
                    </Show>
                  </span>
                </span>
              </li>
            </>
          );
        }}
      </For>
      <Show when={props.timed || last()?.to}>
        <li class="departure-steps__end" style={lineOf(last())}>
          <span class="departure-steps__time">{props.timed ? props.option.arriveTime : ""}</span>
          <span class="departure-steps__station">{last()?.to ?? "Arrive"}</span>
        </li>
      </Show>
    </ol>
  );
}

/**
 * What runs on a leg around its target time, folded under it.
 *
 * Folded, it reads as the one to aim for: for "arrive by", the last that
 * still makes it; for "leave at", the first after. Open, the other
 * departures sit in a strip to pick from, and the picked one is spelled out
 * ride by ride.
 *
 * Google's answers (Korea) are a timetable. NAVITIME's marketplace plan
 * (Japan) has none, only routes and typical ride times, so those boards pick
 * between routes and show no clock times rather than invented departures.
 */
function DepartureBoardView(props: {
  board: DepartureBoard;
  notBefore?: string | undefined;
  /** The leg's travel mode, for the badge that leads the row. */
  mode: string;
  /** Directions for the leg in Maps: one tap, beside the timetable button. */
  mapsHref?: string | undefined;
  mapsLabel?: string | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  const [chosen, setChosen] = createSignal<DepartureOption>();
  const target = () => props.board.target;
  const timed = () => !props.board.approximate;
  /** A day board starts when you get there, or on the day itself from now if that's later. */
  const from = () => {
    if (target().kind !== "day") return props.notBefore;
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
    const today = local.slice(0, 10) === target().date ? local.slice(11, 16) : undefined;
    return [props.notBefore, today].filter((time): time is string => Boolean(time)).sort().at(-1);
  };
  const picked = createMemo(() => pickDeparture(props.board, from()));
  const pick = () => picked().option;
  /** Routes for an untimed board: one per chain of lines, quickest first. */
  const routes = () => {
    const byChain = new Map<string, DepartureOption>();
    for (const option of props.board.options) {
      const seen = byChain.get(chainOf(option));
      if (!seen || option.minutes < seen.minutes) byChain.set(chainOf(option), option);
    }
    return [...byChain.values()].sort((a, b) => a.minutes - b.minutes);
  };
  const choices = () => (timed() ? picked().listed : routes());
  const shown = () => chosen() ?? (timed() ? pick() : routes()[0]);
  const every = () => frequencyOf(props.board.options, shown()?.segments[0]?.name);
  /** Estimated boards can't say a train is missed; only timetables can. */
  const missedTarget = () => (timed() ? picked().missed : undefined);
  const targetLabel = () => {
    const { kind, time, until } = target();
    if (kind === "day") return "Through the day";
    if (kind === "depart") return `Leave from ${time}`;
    return until ? `Arrive ${time}–${until}` : `Arrive by ${time}`;
  };
  const heading = () =>
    [
      missedTarget() ?? targetLabel(),
      timed() && every() ? `every ~${every()} min` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <>
      <div class="travel__inner travel__inner--ride">
        <button
          type="button"
          class="travel__ride"
          aria-expanded={open()}
          aria-label={`${open() ? "Hide" : "Show"} the timetable`}
          onClick={() => setOpen((value) => !value)}
        >
          <span class="travel__glyph">
            <ModeGlyph mode={props.mode} />
          </span>
          <Show when={shown()}>
            {(option) => (
              <span class="travel__lead">
                <span class="travel__times">
                  <Show when={timed()} fallback={<>~{formatDurationShort(option().minutes * 60)}</>}>
                    <strong>{option().departTime}</strong>
                    <span class="travel__arrow">→</span>
                    {option().arriveTime}
                  </Show>
                </span>
                <LineChips option={option()} />
              </span>
            )}
          </Show>
          <span class="travel__timetable" classList={{ "is-open": open() }}>
            <Icon name="timetable" />
          </span>
        </button>
        <Show when={props.mapsHref}>
          {(href) => (
            <a
              class="travel__open"
              href={href()}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={props.mapsLabel}
            >
              <Icon name="map" />
            </a>
          )}
        </Show>
      </div>
      <Show when={open()}>
        <div class="departures departures__body">
          {/* What to aim for and the departures to pick from share a line. */}
          <div class="departures__head">
          <p class="departures__target" classList={{ "is-missed": Boolean(missedTarget()) }}>
            {heading()}
          </p>
          <Show when={choices().length > 1}>
            <div class="departures__choices" role="radiogroup" aria-label={timed() ? "Departures" : "Routes"}>
              <For each={choices()}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    class="departures__choice"
                    classList={{ "is-pick": timed() && option === pick() }}
                    aria-checked={option === shown()}
                    onClick={() => setChosen(option)}
                  >
                    {timed() ? option.departTime : chainOf(option)}
                  </button>
                )}
              </For>
            </div>
          </Show>
          </div>
          <Show when={shown()}>
            {(option) => (
              <>
                <DepartureSteps option={option()} timed={timed()} />
                {/* One ride's length is on its row; a change makes the total worth saying. */}
                <p class="departures__source">
                  <Show when={!timed() || option().segments.length > 1}>
                    {timed() ? "" : "~"}
                    {formatDurationShort(option().minutes * 60)} riding ·{" "}
                  </Show>
                  <Show when={timed()} fallback={<>NAVITIME estimate, not a timetable</>}>
                    <Show when={props.board.source?.type === "curated"} fallback={<>Times from Google</>}>
                      Times: {props.board.source?.operator} timetable
                    </Show>
                  </Show>
                </p>
              </>
            )}
          </Show>
        </div>
      </Show>
    </>
  );
}

/**
 * A failed load removes the slot rather than leaving a broken frame. A
 * place the trip names no photo for gets its slot only once the worker has
 * found one, so a place with none never shows a frame that then goes.
 */
function PlacePhoto(props: { place: Place; mapFallback?: boolean | undefined }) {
  const [blank, setBlank] = createSignal(false);
  const [found, setFound] = createSignal<PhotoFound>();
  createEffect(() => {
    const url = placePhotoUrl(props.place);
    setFound(undefined);
    if (!url || hasNamedPhoto(props.place)) return;
    void findPlacePhoto(url).then((photo) => {
      if (photo && placePhotoUrl(props.place) === url) setFound(photo);
    });
  });
  const photo = () => (hasNamedPhoto(props.place) ? placePhotoUrl(props.place) : found()?.url);
  /** A stay without a photo shows its streets instead. */
  const map = () => (!photo() && props.mapFallback ? staticMapUrl(props.place) : undefined);
  const url = () => photo() ?? map();
  const credit = () => (photo() ? photoAttribution(props.place) ?? found()?.credit : undefined);
  /** Blank or failed this session (place-photo.ts): not shown, and not asked for again on a remount. */
  const failed = () => blank() || Boolean(url() && mediaFailed(url()!));
  const fail = () => {
    const src = url();
    if (src) markMediaFailed(src);
    setBlank(true);
  };
  /** The worker's blank image: no photo after all, or Google unavailable. */
  const onLoad = (event: Event) => {
    if ((event.currentTarget as HTMLImageElement).naturalWidth <= 1) fail();
  };

  return (
    <Show when={!failed() && url()}>
      {(src) => (
        <figure class="stop__photo" classList={{ "stop__photo--map": Boolean(map()) }}>
          {/* The title links to directions; the photo opens the place itself. */}
          <a
            class="stop__photo-link"
            href={buildGooglePlaceUrl(props.place)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${props.place.name} in Google Maps`}
          >
            <img src={src()} alt="" loading="lazy" decoding="async" onLoad={onLoad} onError={fail} />
          </a>
          <Show when={credit()}>
            {(credit) => <figcaption>{credit()}</figcaption>}
          </Show>
        </figure>
      )}
    </Show>
  );
}

/** Copies the full address, for a taxi app or a message; ticks when done. */
function CopyAddress(props: { address?: string | undefined }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      success();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard (an insecure context or a refusal): nothing to show.
    }
  };
  return (
    <Show when={props.address?.trim()}>
      {(address) => (
        <button
          type="button"
          class="icon-link"
          aria-label={copied() ? "Address copied" : `Copy address: ${address()}`}
          title={address()}
          onClick={() => void copy(address())}
        >
          <Icon name={copied() ? "check" : "copy"} />
        </button>
      )}
    </Show>
  );
}

/** Call and website as icons, beside the rating rather than repeated below. */
function ContactIcons(props: { phone?: string | undefined; website?: string | undefined }) {
  return (
    <>
      <Show when={props.phone}>
        {(phone) => (
          <a class="icon-link" href={`tel:${phone().replace(/\s+/g, "")}`} aria-label={`Call ${phone()}`}>
            <Icon name="phone" />
          </a>
        )}
      </Show>
      <Show when={props.website}>
        {(site) => (
          <a class="icon-link" href={site()} target="_blank" rel="noopener noreferrer" aria-label="Website">
            <Icon name="globe" />
          </a>
        )}
      </Show>
    </>
  );
}

/**
 * Today's opening hours as a permanent line: "Open 10:00–17:00". Spelled
 * out with "Open", so it is not mistaken for the time you planned (the
 * calendar pill).
 */
function PlaceHours(props: { place: Place; weekday: number }) {
  const details = () => props.place.details;
  const hours = () => {
    const text = formatOpeningForDay(details()?.openingPeriods, props.weekday);
    return text && /^\d/.test(text) ? `Open ${text}` : text;
  };

  return (
    <Show when={hours()}>
      {(text) => (
        <p class="stop__hours">
          <Icon name="clock" />
          <span>{text()}</span>
        </p>
      )}
    </Show>
  );
}

export function PlaceRow(props: {
  item: PlaceItem;
  place: Place;
  sequence: number;
  /** This stop is one of the trip's stays, not a sightseeing stop. */
  isStay?: boolean | undefined;
  /** 0 = Sunday, for picking the right day's opening hours. */
  weekday: number;
}) {
  const [notesOpen, setNotesOpen] = createSignal(false);
  const category = () => formatCategory(props.place.category);
  /** Full rating with its review count, for the tooltip and screen readers. */
  const rating = () => formatRatingLabel(props.place.rating, props.place.ratingCount);
  /** Where it is, not the street: the photo and name open Maps for that. */
  const area = () => areaOf(props.place.address) ?? props.place.locality;
  const notes = () => props.item.notes?.trim();
  const timed = () => Boolean(props.item.startTime || props.item.endTime);

  return (
    <li class="stop-item">
      <article class="stop" classList={{ "stop--stay": props.isStay, "stop--open": notesOpen() }}>
        {/*
          * Top to bottom: marker with rating and contacts (the planned time
          * pinned on the photo); the name; what it is; today's hours; where
          * it is; then your notes, one line until opened. The photo sits
          * behind, fading in from the right.
          */}
        <div class="stop__body">
          <div class="stop__top">
            <span class="stop__badge">
              <Show when={props.isStay} fallback={<span class="stop__num">{props.sequence}</span>}>
                <ModeGlyph mode="lodging" />
              </Show>
            </span>
            <span class="stop__actions">
              <Show when={rating() ? props.place.rating : undefined}>
                {(score) => (
                  <span class="stop__rating" title={rating()}>
                    <span class="with-icon" aria-hidden="true">
                      <Icon name="star" />
                      {score().toFixed(1)}
                    </span>
                    <Hidden>{`Rated ${rating()?.replace("★ ", "")}`}</Hidden>
                  </span>
                )}
              </Show>
              <ContactIcons phone={props.place.details?.phone} website={props.place.details?.website} />
              <CopyAddress address={props.place.address} />
            </span>
            {/* Your planned time, pinned on the photo's corner (or the row's
                end without one), with a calendar so it reads as a plan. */}
            <Show when={timed()}>
              <span class="stop__when" title="Planned in Wanderlog">
                <Icon name="calendar" />
                <Hidden>Planned </Hidden>
                <TimeLabel start={props.item.startTime} end={props.item.endTime} />
              </span>
            </Show>
          </div>
          <a
            class="stop__name"
            href={buildGoogleMapsUrl(props.place)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {props.place.name}
          </a>
          <Show when={category()}>{(text) => <p class="stop__meta">{text()}</p>}</Show>
          <PlaceHours place={props.place} weekday={props.weekday} />
          <Show when={area()}>{(where) => <p class="stop__where">{where()}</p>}</Show>
          <StatusPill status={props.item.status} />
          <Show when={notes()}>{(text) => <NotesLine text={text()} open={notesOpen()} onToggle={setNotesOpen} />}</Show>
        </div>
        <PlacePhoto place={props.place} mapFallback={props.isStay} />
      </article>
    </li>
  );
}

/**
 * Your notes as a card's last line: the first line as a preview with a
 * chevron, opening in place to the whole note, formatted as in Wanderlog.
 * The whole line toggles, except a link inside the opened note.
 */
function NotesLine(props: { text: string; open: boolean; onToggle: (open: boolean) => void }) {
  const toggle = (event: MouseEvent) => {
    if ((event.target as Element).closest("a")) return;
    props.onToggle(!props.open);
  };
  return (
    <div class="stop__notes" classList={{ "is-open": props.open }} onClick={toggle}>
      <Show when={props.open} fallback={<span class="stop__notes-text">{notesPreview(props.text)}</span>}>
        <RichNotes text={props.text} class="stop__notes-body" />
      </Show>
      <button
        type="button"
        class="stop__notes-toggle"
        aria-expanded={props.open}
        aria-label={props.open ? "Hide notes" : "Show notes"}
      >
        <span class="stop__chevron" classList={{ "is-open": props.open }} aria-hidden="true" />
      </button>
    </div>
  );
}

export function FlightConnector(props: { item: FlightItem }) {
  /** "JQ 34", the way a boarding pass writes it; the full name if no code. */
  const code = () =>
    [props.item.airlineCode ?? props.item.airline, props.item.flightNumber]
      .filter(Boolean)
      .join(" ") || "Flight";
  const route = () =>
    [props.item.departAirport, props.item.arriveAirport].filter(Boolean).join(" → ");
  const times = () => [props.item.departTime, props.item.arriveTime].filter(Boolean).join("–");
  const nextDay = () =>
    Boolean(props.item.arriveDate && props.item.departDate && props.item.arriveDate !== props.item.departDate);

  /* The in-route form of a flight; the full card lives in the day summary. */
  return (
    <li class="flight-pill">
      <div class="flight-pill__card">
        <span class="kind-badge kind-badge--flight" aria-hidden="true">
          <ModeGlyph mode="flight" />
        </span>
        <span class="flight-pill__route">{route() || code()}</span>
        <span class="flight-pill__detail">
          <Show when={route()}>
            <span>{code()}</span>
          </Show>
          <Show when={times()}>
            <span>
              {times()}
              <Show when={nextDay()}>
                <sup class="flight-end__plus" title="Arrives the next day">
                  +1
                </sup>
              </Show>
            </span>
          </Show>
        </span>
      </div>
    </li>
  );
}

/**
 * The hotel a day's route leaves from or returns to, as a one-line card like
 * a flight's: the leg beside it then needs no "from" or "to". The full card,
 * with check-in and booking, lives in the day summary.
 */
export function HotelPill(props: {
  name: string;
  place?: Place | undefined;
  /** When to leave the hotel: for a flight, or for the day's first planned stop. */
  leaveBy?: string | undefined;
  /** Tonight is the first night here. */
  checkIn?: boolean | undefined;
}) {
  return (
    <li class="flight-pill hotel-pill">
      <div class="flight-pill__card">
        <span class="kind-badge kind-badge--lodging" aria-hidden="true">
          <ModeGlyph mode="lodging" />
        </span>
        <Show when={props.place} fallback={<span class="hotel-pill__name">{stayDisplay(props.name).name}</span>}>
          {(place) => (
            <a class="hotel-pill__name" href={buildGoogleMapsUrl(place())} target="_blank" rel="noopener noreferrer">
              {stayDisplay(props.name, place()).name}
            </a>
          )}
        </Show>
        <Show when={props.leaveBy}>
          {(time) => (
            <span class="flight-pill__detail hotel-pill__phase" title="Leave by">
              <Icon name="check-out" />
              <Hidden>Leave by </Hidden>
              <span>{time()}</span>
            </span>
          )}
        </Show>
        <Show when={props.checkIn}>
          <span class="flight-pill__detail hotel-pill__phase">
            <Icon name="check-in" />
            <span>Check in</span>
          </span>
        </Show>
      </div>
    </li>
  );
}

/**
 * A night in the middle of a stay, in the day summary: the hotel is already
 * known from the day you checked in, so one line, not the whole card again.
 */
export function StayLine(props: { item: LodgingItem; place?: Place | undefined; date: string }) {
  const name = () => stayDisplay(props.item.name, props.place).name;
  const nights = () => nightsBetween(props.item.checkInDate, props.item.checkOutDate);
  const night = () => {
    const before = props.item.checkInDate ? nightsBetween(props.item.checkInDate, props.date) : undefined;
    return before === undefined ? undefined : before + 1;
  };
  return (
    <div class="stay-line">
      <span class="kind-badge kind-badge--lodging" aria-hidden="true">
        <ModeGlyph mode="lodging" />
      </span>
      <Show when={props.place} fallback={<span class="stay-line__name">{name()}</span>}>
        {(place) => (
          <a class="stay-line__name" href={buildGoogleMapsUrl(place())} target="_blank" rel="noopener noreferrer">
            {name()}
          </a>
        )}
      </Show>
      <Show when={night() && nights()}>
        <span class="stay-line__night">
          Night {night()} of {nights()}
        </span>
      </Show>
      <CopyAddress address={props.place?.address} />
    </div>
  );
}

export function FlightRow(props: {
  item: FlightItem;
  timing?: FlightTiming | undefined;
  /** Names where you leave from; unset when the hotel band shows it instead. */
  leaveLabel?: string | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  /** "Jetstar JQ34": the airline, then the flight as the boarding pass prints it. */
  const code = () => {
    const number = props.item.flightNumber
      ? `${props.item.airlineCode ?? ""}${props.item.flightNumber}`
      : undefined;
    return [props.item.airline, number].filter(Boolean).join(" ") || "Flight";
  };
  /** Wanderlog gives both ends a date; they differ on an overnight hop. */
  const overnight = () =>
    Boolean(
      props.item.departDate &&
        props.item.arriveDate &&
        props.item.arriveDate !== props.item.departDate,
    );
  const extraNotes = () =>
    noteRestatesNames(props.item.notes, props.item.travellerNames) ? undefined : props.item.notes;
  const hasDetail = () =>
    Boolean(props.item.confirmationNumber || props.item.travellerNames?.length || extraNotes());
  /** "Booking QF7XKA · 2 travellers", or the note's first words without one. */
  const bookingLine = () => {
    const travellers = props.item.travellerNames?.length;
    const parts = [
      props.item.confirmationNumber && `Booking ${props.item.confirmationNumber}`,
      travellers && `${travellers} traveller${travellers === 1 ? "" : "s"}`,
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : (extraNotes()?.trim() ?? "Booking");
  };

  return (
    <li class="stop-item">
      <article class="card card--flight">
        <div class="card__body">
          <div class="card__kind">
            <span class="kind-badge kind-badge--flight" aria-hidden="true">
              <ModeGlyph mode="flight" />
            </span>
            <span>{code()}</span>
          </div>

          {/* Times and airports on one line, as a departures board reads. */}
          <div class="flight-legs">
            <span class="flight-end__time">{props.item.departTime ?? "—"}</span>
            <span class="flight-end__code">{props.item.departAirport}</span>
            <div class="flight-path" aria-hidden="true">
              <span class="flight-path__line" />
              <ModeGlyph mode="flight" />
              <span class="flight-path__line" />
            </div>
            <span class="flight-end__code">{props.item.arriveAirport}</span>
            <span class="flight-end__time">
              {props.item.arriveTime ?? "—"}
              <Show when={overnight()}>
                <sup class="flight-end__plus" title="Arrives the next day">
                  +1
                </sup>
              </Show>
            </span>
          </div>
          {/* The airport margin sits under the departure it belongs to. */}
          <div class="flight-cities">
            <span class="flight-end__city">
              {props.item.departCity}
              <Show when={props.timing}>
                {(timing) => (
                  <span class="flight-by">
                    <Icon name="clock" />
                    <span>
                      At airport <strong>{timing().airportBy}</strong>–{timing().airportUntil}
                    </span>
                  </span>
                )}
              </Show>
            </span>
            <span class="flight-end__city">{props.item.arriveCity}</span>
          </div>

          <StatusPill status={props.item.status} />

          <div class="flight-foot">
            <Show when={props.leaveLabel && props.timing?.leaveBy}>
              {(leaveBy) => (
                <p class="leave-time">
                  {props.leaveLabel} <strong>{leaveBy()}</strong>
                </p>
              )}
            </Show>
          </div>
          {/* The booking as the last line, opening to travellers and notes. */}
          <Show when={hasDetail()}>
            <button
              type="button"
              class="stop__notes"
              aria-expanded={open()}
              onClick={() => setOpen((v) => !v)}
            >
              <span class="stop__notes-text">{bookingLine()}</span>
              <span class="stop__chevron" classList={{ "is-open": open() }} aria-hidden="true" />
            </button>
          </Show>
          <Show when={open()}>
            <div class="card__detail">
              <Show when={props.item.confirmationNumber}>
                {(reference) => (
                  <p class="card__detail-row">
                    <span class="card__detail-label">Booking</span>
                    <span class="card__ref card__ref--dark">{reference()}</span>
                  </p>
                )}
              </Show>
              <Show when={props.item.travellerNames?.length}>
                <p class="card__detail-row">
                  <span class="card__detail-label">Travellers</span>
                  {props.item.travellerNames?.join(", ")}
                </p>
              </Show>
              <Show when={extraNotes()}>{(text) => <RichNotes text={text()} />}</Show>
            </div>
          </Show>
        </div>
      </article>
    </li>
  );
}

/** A note longer than this, or of more than one line, starts folded to its first line. */
const LONG_NOTE_CHARACTERS = 140;

/**
 * A note between stops: a quiet block hung off the route rail, formatted as
 * in Wanderlog. A long one starts as its first line and opens in place, the
 * way a stop's notes do; consecutive notes join into one block (in CSS).
 */
export function NoteRow(props: { item: NoteItem }) {
  const [open, setOpen] = createSignal(false);
  const text = () => formatArrows(props.item.text).trim();
  const long = () => text().includes("\n") || text().length > LONG_NOTE_CHARACTERS;
  const toggle = (event: MouseEvent) => {
    if ((event.target as Element).closest("a")) return;
    setOpen((value) => !value);
  };
  return (
    <li class="note-item">
      <span class="note-item__mark" aria-hidden="true">
        <Icon name="note" />
      </span>
      <Show when={long()} fallback={<RichNotes text={text()} class="note-text" />}>
        <div class="note-text note-text--fold" classList={{ "is-open": open() }} onClick={toggle}>
          <Show when={open()} fallback={<span class="stop__notes-text">{notesPreview(text())}</span>}>
            <RichNotes text={text()} />
          </Show>
          <button
            type="button"
            class="stop__notes-toggle"
            aria-expanded={open()}
            aria-label={open() ? "Show less of the note" : "Show the whole note"}
          >
            <span class="stop__chevron" classList={{ "is-open": open() }} aria-hidden="true" />
          </button>
        </div>
      </Show>
    </li>
  );
}

export type LodgingCardRole = "check-out" | "check-in" | "morning" | "evening" | "stay";

/** A stay as a day bookend, above or below the day's timeline. */
export function LodgingBand(props: {
  item: LodgingItem;
  place?: Place | undefined;
  role?: LodgingCardRole | undefined;
  /** When to leave for the airport, on the day you check out. */
  checkOutBy?: string | undefined;
  /**
   * Starts as one line that opens to the whole band: for the hotel you are
   * leaving, whose address and photo you no longer need at a glance.
   */
  compact?: boolean | undefined;
}) {
  const [open, setOpen] = createSignal(false);
  const [folded, setFolded] = createSignal(true);

  const role = (): LodgingCardRole => {
    if (props.role) return props.role;
    if (props.item.phase === "check-in") return "check-in";
    if (props.item.phase === "check-out") return "check-out";
    return "stay";
  };

  const phaseLabel = () => {
    switch (role()) {
      case "check-in":
        return "Check in";
      case "check-out":
        return "Check out";
      case "morning":
        return "Woke here";
      case "evening":
        return "Tonight";
      default:
        return "Staying";
    }
  };

  const nights = () => nightsBetween(props.item.checkInDate, props.item.checkOutDate);
  const nightsLabel = () => {
    const value = nights();
    return value === undefined ? undefined : `${value} night${value === 1 ? "" : "s"}`;
  };
  /** Booking, travellers or notes: what the bottom line opens to. */
  const hasDetail = () =>
    Boolean(props.item.confirmationNumber || props.item.notes?.trim() || props.item.travellerNames?.length);
  const stayLine = () =>
    [
      props.item.checkInDate && props.item.checkOutDate
        ? `${formatTabDayMonth(props.item.checkInDate)} → ${formatTabDayMonth(props.item.checkOutDate)}`
        : undefined,
      nightsLabel(),
    ]
      .filter(Boolean)
      .join(" · ");
  const rating = () => formatRatingLabel(props.place?.rating, props.place?.ratingCount);
  const category = () => formatCategory(props.place?.category);
  const area = () => areaOf(props.place?.address) ?? props.place?.locality;
  const shownName = () => stayDisplay(props.item.name, props.place);

  return (
    <Show
      when={!(props.compact && folded())}
      fallback={
        <button
          type="button"
          class="stay-line stay-line--fold"
          aria-expanded="false"
          aria-label={`${phaseLabel()}, ${shownName().name}: show the hotel`}
          onClick={() => setFolded(false)}
        >
          <span class="kind-badge kind-badge--lodging" aria-hidden="true">
            <ModeGlyph mode="lodging" />
          </span>
          <span class="lodging-band__phase">{phaseLabel()}</span>
          <span class="stay-line__name">{shownName().name}</span>
          <Show when={props.checkOutBy} fallback={<span class="stay-line__night">{nightsLabel()}</span>}>
            {(time) => <span class="stay-line__night">by {time()}</span>}
          </Show>
        </button>
      }
    >
    <div
      class="lodging-band"
      classList={{
        "lodging-band--in": role() === "check-in",
        "lodging-band--out": role() === "check-out",
        "lodging-band--open": open(),
      }}
    >
      {/* Laid out as a stop card: marker and contacts, the name, what and
          where, then the stay as the last line, which opens the booking. */}
      <div class="stop__body">
        <div class="stop__top">
          <span class="kind-badge kind-badge--lodging" aria-hidden="true">
            <ModeGlyph mode="lodging" />
          </span>
          <Show when={props.compact} fallback={<span class="lodging-band__phase">{phaseLabel()}</span>}>
            {/* The label folds the band back to its one line. */}
            <button
              type="button"
              class="lodging-band__phase lodging-band__fold"
              aria-expanded="true"
              aria-label={`${phaseLabel()}: show less`}
              onClick={() => setFolded(true)}
            >
              {phaseLabel()}
            </button>
          </Show>
          <span class="stop__actions">
            <Show when={rating() ? props.place?.rating : undefined}>
              {(score) => (
                <span class="stop__rating" title={rating()}>
                  <span class="with-icon" aria-hidden="true">
                    <Icon name="star" />
                    {score().toFixed(1)}
                  </span>
                  <Hidden>{`Rated ${rating()?.replace("★ ", "")}`}</Hidden>
                </span>
              )}
            </Show>
            <ContactIcons phone={props.item.phone} website={props.item.website} />
            <CopyAddress address={props.place?.address} />
          </span>
          {/* On the day you leave, when to be out, pinned like a planned time. */}
          <Show when={props.checkOutBy}>
            {(time) => (
              <span class="stop__when" title="Check out by">
                <Icon name="check-out" />
                <Hidden>Check out </Hidden>
                <span>by {time()}</span>
              </span>
            )}
          </Show>
        </div>
        <Show
          when={props.place}
          fallback={<span class="stop__name stop__name--plain">{shownName().name}</span>}
        >
          {(place) => (
            <a class="stop__name" href={buildGoogleMapsUrl(place())} target="_blank" rel="noopener noreferrer">
              {shownName().name}
            </a>
          )}
        </Show>
        <Show when={category()}>{(text) => <p class="stop__meta">{text()}</p>}</Show>
        <Show when={shownName().street ?? area()}>{(where) => <p class="stop__where">{where()}</p>}</Show>
        <Show when={stayLine()}>
          {(line) => (
            <Show
              when={hasDetail()}
              fallback={
                <p class="stop__notes stop__notes--static">
                  <span class="stop__notes-text">{line()}</span>
                </p>
              }
            >
              <button
                type="button"
                class="stop__notes"
                aria-expanded={open()}
                aria-label={`${line()}, ${open() ? "hide" : "show"} booking`}
                onClick={() => setOpen((v) => !v)}
              >
                <span class="stop__notes-text">{line()}</span>
                <span class="stop__chevron" classList={{ "is-open": open() }} aria-hidden="true" />
              </button>
            </Show>
          )}
        </Show>
        <Show when={open()}>
          <div class="lodging-band__detail">
            {/* Wanderlog carries no check-in/out times, so none are shown. */}
            <Show when={props.item.confirmationNumber}>
              {(reference) => (
                <p class="card__detail-row">
                  <span class="card__detail-label">Booking</span>
                  <span class="card__ref card__ref--dark">{reference()}</span>
                </p>
              )}
            </Show>
            <Show when={props.item.travellerNames?.length}>
              <p class="card__detail-row">
                <span class="card__detail-label">Booked by</span>
                {props.item.travellerNames?.join(", ")}
              </p>
            </Show>
            <Show when={props.item.notes?.trim()}>
              {(text) => <RichNotes text={text()} class="lodging-band__notes" />}
            </Show>
          </div>
        </Show>
      </div>
      {/* The hotel's photo, or for an address-only stay the streets round it. */}
      <Show when={props.place}>{(place) => <PlacePhoto place={place()} mapFallback />}</Show>
    </div>
    </Show>
  );
}

export function DayItemRow(props: {
  item: DayItem;
  bundle: TripBundle;
  placeSequence: number;
  isStay?: boolean | undefined;
  weekday: number;
}): JSX.Element {
  const item = props.item;
  switch (item.type) {
    case "place": {
      const place = props.bundle.places[item.placeId];
      if (!place) {
        return (
          <li class="note-item">
            <p class="note-text">Missing place data for {item.placeId}</p>
          </li>
        );
      }
      return (
        <PlaceRow
          item={item}
          place={place}
          sequence={props.placeSequence}
          isStay={props.isStay}
          weekday={props.weekday}
        />
      );
    }
    case "transit": {
      const leg = item.routeLegId ? props.bundle.routeLegs[item.routeLegId] : undefined;
      return leg ? (
        <RouteLegRow leg={leg} places={props.bundle.places} />
      ) : (
        <li class="note-item">
          <p class="note-text">{item.label ?? "Travel"}</p>
        </li>
      );
    }
    case "flight":
      return <FlightRow item={item} />;
    case "lodging": {
      const place = item.placeId ? props.bundle.places[item.placeId] : undefined;
      return (
        <li class="lodging-item">
          <LodgingBand item={item} place={place} />
        </li>
      );
    }
    case "note":
      return <NoteRow item={item} />;
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}
