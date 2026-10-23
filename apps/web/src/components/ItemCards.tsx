import { For, Show, createSignal, type JSX } from "solid-js";
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
import { RichNotes } from "./RichNotes";
import { buildGoogleMapsUrl, buildGooglePlaceUrl, buildLegDirectionsUrl } from "../lib/maps";
import { photoAttribution, placePhotoUrl, staticMapUrl } from "../lib/place-photo";
import { LONG_LEG_SECONDS } from "../lib/route-legs";
import type { FlightTiming } from "../lib/day-times";
import { GoogleMapsIcon } from "./GoogleMapsIcon";
import { Hidden, Icon } from "./Icon";

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

const MODE_PATHS: Record<string, string> = {
  // Simple 16x16 glyphs: a walker, a train car, a car, a bike, a boat, a plane.
  walking: "M9 3.5a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8ZM7.6 4.6 5 7l1 3.4M9.4 4.6l1.8 1.6.9 2.6M8.6 8.2 7.4 11l-2 4.2M8.6 8.2l2 2.4.6 4.6",
  transit: "M4.5 1.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM2.5 6.5h11M5 9.5h.01M11 9.5h.01M5.5 12.5 3.5 15M10.5 12.5l2 2.5",
  driving: "M2 9.5 3.4 5.2A2 2 0 0 1 5.3 3.8h5.4a2 2 0 0 1 1.9 1.4L14 9.5M2 9.5h12M2 9.5v3h2.5v-3M14 9.5v3h-2.5v-3M4.8 11h.01M11.2 11h.01",
  cycling: "M4 13.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM12 13.5a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM4 11h4l2.5-5M6.5 6h3M10.5 6l1.5 5",
  ferry: "M2.5 12.5c1.4 0 1.4 1.2 2.8 1.2s1.4-1.2 2.8-1.2 1.4 1.2 2.8 1.2 1.4-1.2 2.6-1.2M3.5 10 5 6.5h6L12.5 10M8 6.5v-3M6 3.5h4",
  // Lucide's "plane" (ISC), scaled from 24 to 16: nose up and to the right.
  flight:
    "M11.87 12.8 10.67 7.33l2.33-2.33C14 4 14.33 2.67 14 2c-.67-.33-2 0-3 1L8.67 5.33 3.2 4.13c-.33-.07-.6.07-.73.33l-.2.33c-.13.33-.07.67.2.87L6 8l-1.33 2H2.67l-.67.67 2 1.33 1.33 2 .67-.67v-2l2-1.33 2.33 3.53c.2.27.53.33.87.2l.33-.13c.27-.2.4-.47.33-.8Z",
  lodging: "M2 12.5v-9M2 8h9a3 3 0 0 1 3 3v1.5M2 12.5h12M4.8 6.2h1.6a1.4 1.4 0 0 1 0 2.8H4.8a1.4 1.4 0 0 1 0-2.8Z",
};

function ModeGlyph(props: { mode: string }) {
  return (
    <svg class="mode-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d={MODE_PATHS[props.mode] ?? MODE_PATHS.walking} />
    </svg>
  );
}

/**
 * Travel between two stops. Wanderlog computes these but stores them outside
 * the day list, so nothing rendered them before.
 *
 * Under an hour it is a thin tinted strip — clearly a different kind of thing
 * from a stop, but subordinate to it. An hour or more is a haul, and gets a
 * block whose height grows with the duration so a long transfer *feels* long
 * when you scroll past it.
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
}) {
  const long = () => (props.leg.durationSeconds ?? 0) >= LONG_LEG_SECONDS;

  const detail = () =>
    [
      formatDurationShort(props.leg.durationSeconds),
      formatDistance(props.leg.distanceMetres),
      props.note,
    ]
      .filter(Boolean)
      .join(" · ");

  /**
   * Scale between the 1 h threshold and the longest real leg in a trip of this
   * shape (~2.5 h). Clamped, so an outlier cannot blow out the page.
   */
  const blockHeight = () => {
    const minutes = (props.leg.durationSeconds ?? 0) / 60;
    const ratio = Math.min(1, Math.max(0, (minutes - 60) / (155 - 60)));
    return `${3.4 + ratio * 5}rem`;
  };

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
        <span class="travel__text">
          <span class="travel__ends">
            {props.places[props.leg.fromPlaceId]?.name} → {props.places[props.leg.toPlaceId]?.name}
          </span>
          <Show when={detail()}>
            <span class="travel__detail">{detail()}</span>
          </Show>
        </span>
      </Show>
    </>
  );

  return (
    <li
      class={`travel travel--${props.leg.travelMode}`}
      classList={{ "travel--long": long() }}
      style={long() ? { "--travel-height": blockHeight() } : undefined}
    >
      <Show when={directions()} fallback={<div class="travel__inner">{contents()}</div>}>
        {(href) => (
          <a
            class="travel__inner travel__link"
            href={href()}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${formatTravelMode(props.leg.travelMode)} directions, ${
              props.places[props.leg.fromPlaceId]?.name
            } to ${props.places[props.leg.toPlaceId]?.name}`}
          >
            {contents()}
            <span class="travel__open">
              <GoogleMapsIcon />
            </span>
          </a>
        )}
      </Show>
      <Show when={props.board}>{(board) => <DepartureBoardView board={board()} />}</Show>
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

/** "Skyliner › Oedo Line": the rides of an option, as one key. */
const chainOf = (option: DepartureOption) => option.segments.map((segment) => segment.name).join(" › ");

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
 * One way through, ride by ride: where to board and which way the train is
 * headed (what the platform signs show), and where to change. A timetabled
 * option gives clock times; an untimed one gives each ride's typical length.
 */
function DepartureSteps(props: { option: DepartureOption; timed: boolean }) {
  const last = () => props.option.segments.at(-1);
  return (
    <ol class="departure-steps">
      <For each={props.option.segments}>
        {(segment, index) => {
          const previous = () => props.option.segments[index() - 1];
          const wait = () => previous() && minutesBetween(previous()!.arriveTime, segment.departTime);
          return (
            <>
              <Show when={previous()}>
                {(before) => (
                  <li class="departure-steps__change">
                    Change{before().to ? ` at ${before().to}` : ""}
                    <Show when={props.timed && wait()}>{(minutes) => ` · ${minutes()} min`}</Show>
                  </li>
                )}
              </Show>
              <li class="departure-steps__ride">
                <span class="departure-steps__time">
                  {props.timed
                    ? segment.departTime
                    : `~${formatDurationShort(minutesBetween(segment.departTime, segment.arriveTime) * 60)}`}
                </span>
                <span class="departure-steps__what">
                  <LineChip segment={segment} />
                  <Show when={segment.from || segment.headsign}>
                    <span class="departure-steps__where">
                      {[segment.from && `From ${segment.from}`, segment.headsign && `towards ${segment.headsign}`]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                  </Show>
                </span>
              </li>
            </>
          );
        }}
      </For>
      <Show when={props.timed || last()?.to}>
        <li class="departure-steps__end">
          <span class="departure-steps__time">{props.timed ? props.option.arriveTime : ""}</span>
          <span class="departure-steps__where">{last()?.to ? `Arrive ${last()!.to}` : "Arrive"}</span>
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
function DepartureBoardView(props: { board: DepartureBoard }) {
  const [open, setOpen] = createSignal(false);
  const [chosen, setChosen] = createSignal<DepartureOption>();
  const target = () => props.board.target;
  const timed = () => !props.board.approximate;
  const pick = () => {
    const options = props.board.options;
    if (target().kind === "arrive") {
      const fits = options.filter((option) => option.arriveTime <= target().time);
      return fits.at(-1) ?? options[0];
    }
    return options.find((option) => option.departTime >= target().time) ?? options.at(-1);
  };
  /** Routes for an untimed board: one per chain of lines, quickest first. */
  const routes = () => {
    const byChain = new Map<string, DepartureOption>();
    for (const option of props.board.options) {
      const seen = byChain.get(chainOf(option));
      if (!seen || option.minutes < seen.minutes) byChain.set(chainOf(option), option);
    }
    return [...byChain.values()].sort((a, b) => a.minutes - b.minutes);
  };
  const choices = () => (timed() ? props.board.options : routes());
  const shown = () => chosen() ?? (timed() ? pick() : routes()[0]);
  const every = () => frequencyOf(props.board.options, shown()?.segments[0]?.name);
  const heading = () =>
    [
      `${target().kind === "arrive" ? "Arrive by" : "Leave from"} ${target().time}`,
      timed() && every() ? `every ~${every()} min` : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div class="departures" classList={{ "is-open": open() }}>
      <button
        type="button"
        class="departures__toggle"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={timed() ? "clock" : "route"} />
        <Show when={shown()}>
          {(option) => (
            <>
              <span class="departures__when">
                <Show
                  when={timed()}
                  fallback={<>~{formatDurationShort(option().minutes * 60)}</>}
                >
                  <strong>{option().departTime}</strong>→{option().arriveTime}
                </Show>
              </span>
              <span class="departures__chain">{chainOf(option())}</span>
            </>
          )}
        </Show>
        <span class="departures__chevron" classList={{ "is-open": open() }} aria-hidden="true" />
      </button>
      <Show when={open()}>
        <div class="departures__body">
          <p class="departures__target">{heading()}</p>
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
          <Show when={shown()}>
            {(option) => (
              <>
                <DepartureSteps option={option()} timed={timed()} />
                <p class="departures__source">
                  <Show
                    when={timed()}
                    fallback={<>~{formatDurationShort(option().minutes * 60)} riding · NAVITIME estimate, not a timetable</>}
                  >
                    {formatDurationShort(option().minutes * 60)} riding · Times from Google
                  </Show>
                </p>
              </>
            )}
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * Loaded straight from Google — the licence forbids re-hosting, so there is no
 * local copy and nothing to show offline. A failed load removes the slot
 * entirely rather than leaving a broken frame.
 */
function PlacePhoto(props: { place: Place; mapFallback?: boolean | undefined }) {
  const [failed, setFailed] = createSignal(false);
  const photo = () => placePhotoUrl(props.place);
  /** A stay without a photo shows its streets instead. */
  const map = () => (!photo() && props.mapFallback ? staticMapUrl(props.place) : undefined);
  const url = () => photo() ?? map();

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
            <img src={src()} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
          </a>
          <Show when={photoAttribution(props.place)}>
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
 * The in-route form of a flight: the full card lives in the day summary, so
 * here it only has to say "this hop is the flight, not a ground route".
 */
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

  /* A thin one-line card, as Wanderlog draws a flight in the day: the full
     card with timings and booking lives in the day summary. */
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
        <Show when={props.place} fallback={<span class="hotel-pill__name">{props.name}</span>}>
          {(place) => (
            <a class="hotel-pill__name" href={buildGoogleMapsUrl(place())} target="_blank" rel="noopener noreferrer">
              {props.name}
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
                    <Hidden>{`At ${props.item.departAirport ?? "the airport"} by `}</Hidden>
                    <span aria-hidden="true">by </span>
                    <strong>{timing().airportBy}</strong>
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

export function NoteRow(props: { item: NoteItem }) {
  return (
    <li class="note-item">
      <RichNotes text={formatArrows(props.item.text)} class="note-text" />
    </li>
  );
}

export type LodgingCardRole = "check-out" | "check-in" | "morning" | "evening" | "stay";

/**
 * Lodging is a day bookend, not a stop: it reads as a slim band above or below
 * the day's timeline. Full check-in/out dates expand only on the days the stay
 * actually starts or ends.
 */
export function LodgingBand(props: {
  item: LodgingItem;
  place?: Place | undefined;
  role?: LodgingCardRole | undefined;
  /** When to leave for the airport, on the day you check out. */
  checkOutBy?: string | undefined;
}) {
  const [open, setOpen] = createSignal(false);

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

  return (
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
          <span class="lodging-band__phase">{phaseLabel()}</span>
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
          fallback={<span class="stop__name stop__name--plain">{props.item.name}</span>}
        >
          {(place) => (
            <a class="stop__name" href={buildGoogleMapsUrl(place())} target="_blank" rel="noopener noreferrer">
              {props.item.name}
            </a>
          )}
        </Show>
        <Show when={category()}>{(text) => <p class="stop__meta">{text()}</p>}</Show>
        <Show when={area()}>{(where) => <p class="stop__where">{where()}</p>}</Show>
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
