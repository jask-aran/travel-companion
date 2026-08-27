import { For, Show, createSignal, type JSX } from "solid-js";
import type {
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
  cleanAddress,
  formatArrows,
  formatDistance,
  formatDuration,
  formatLodgingDate,
  formatRating,
  formatOpeningForDay,
  formatTravelMode,
  formatVisitLength,
  nightsBetween,
  noteRestatesNames,
} from "../lib/format";
import { buildGoogleMapsUrl, buildGooglePlaceUrl } from "../lib/maps";
import { photoAttribution, placePhotoUrl } from "../lib/place-photo";
import { LONG_LEG_SECONDS } from "../lib/route-legs";

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

/**
 * Notes clamp by line, not by character count: the old `length > 110` heuristic
 * left the identical six-name passenger list expanded on every flight.
 */
function Notes(props: { text?: string | undefined; label?: string | undefined }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.text?.trim()}>
      {(text) => (
        <div class="item-notes">
          <p class="item-notes__text" classList={{ "item-notes__text--open": open() }}>
            {text()}
          </p>
          <button type="button" class="text-button" onClick={() => setOpen((v) => !v)}>
            {open() ? "Less" : (props.label ?? "More")}
          </button>
        </div>
      )}
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
  flight: "M8 1.5 9.5 7l4.5 2.4v1.4L9.5 9.6l-.4 3.2 1.7 1.3v1L8 14.2l-2.8.9v-1l1.7-1.3-.4-3.2L2 10.8V9.4L6.5 7 8 1.5Z",
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
export function RouteLegRow(props: { leg: RouteLeg }) {
  const long = () => (props.leg.durationSeconds ?? 0) >= LONG_LEG_SECONDS;

  const detail = () =>
    [formatDuration(props.leg.durationSeconds), formatDistance(props.leg.distanceMetres)]
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

  return (
    <li
      class="travel"
      classList={{ "travel--long": long() }}
      style={long() ? { "--travel-height": blockHeight() } : undefined}
    >
      <span class="travel__glyph">
        <ModeGlyph mode={props.leg.travelMode} />
      </span>
      <span class="travel__mode">{formatTravelMode(props.leg.travelMode)}</span>
      <Show when={detail()}>
        <span class="travel__detail">{detail()}</span>
      </Show>
    </li>
  );
}

/**
 * Loaded straight from Google — the licence forbids re-hosting, so there is no
 * local copy and nothing to show offline. A failed load removes the slot
 * entirely rather than leaving a broken frame.
 */
function PlacePhoto(props: { place: Place }) {
  const [failed, setFailed] = createSignal(false);
  const url = () => placePhotoUrl(props.place);

  return (
    <Show when={!failed() && url()}>
      {(src) => (
        <figure class="stop__photo">
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

/** True when Wanderlog scraped anything worth showing for this place. */
export function hasPlaceDetail(place: Place): boolean {
  const d = place.details;
  if (!d) return false;
  return Boolean(
    d.description || d.summary || d.openingPeriods?.length || d.visitMinutesMin ||
      d.categories?.length || d.website || d.phone,
  );
}

/**
 * Wanderlog's scraped POI record. Opening hours and visit length stay on the
 * card because they change what you would do; the rest is reference material,
 * revealed by the chevron on the card's rail rather than a full-width button.
 */
function PlaceDetail(props: { place: Place; weekday: number; open: boolean }) {
  const details = () => props.place.details;

  const hours = () => formatOpeningForDay(details()?.openingPeriods, props.weekday);
  const visit = () =>
    formatVisitLength(details()?.visitMinutesMin, details()?.visitMinutesMax);
  const blurb = () => details()?.description ?? details()?.summary;
  const categories = () => details()?.categories?.slice(0, 4);

  return (
    <Show when={hasPlaceDetail(props.place)}>
      <div class="detail">
        <Show when={hours() || visit()}>
          <div class="detail__glance">
            <Show when={hours()}>
              {(text) => <span class="detail__chip detail__chip--hours">{text()}</span>}
            </Show>
            <Show when={visit()}>
              {(text) => <span class="detail__chip">~{text()} visit</span>}
            </Show>
          </div>
        </Show>

        <Show when={props.open}>
          <div class="detail__body">
            <Show when={blurb()}>{(text) => <p class="detail__blurb">{text()}</p>}</Show>
            <Show when={categories()?.length}>
              <ul class="detail__tags">
                <For each={categories()}>{(tag) => <li>{tag}</li>}</For>
              </ul>
            </Show>
            <div class="detail__links">
              <Show when={details()?.phone}>
                {(phone) => (
                  <a class="text-button" href={`tel:${phone().replace(/\s+/g, "")}`}>
                    Call
                  </a>
                )}
              </Show>
              <Show when={details()?.website}>
                {(site) => (
                  <a class="text-button" href={site()} target="_blank" rel="noopener noreferrer">
                    Website
                  </a>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
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
  const [detailOpen, setDetailOpen] = createSignal(false);
  const meta = () =>
    [props.place.category?.replace(/_/g, " "), formatRating(props.place.rating, props.place.ratingCount)]
      .filter(Boolean)
      .join("  ·  ");

  return (
    <li class="stop-item">
      <article class="stop" classList={{ "stop--stay": props.isStay }}>
        <div class="stop__rail">
          <div class="stop__badge">
            <Show
              when={props.isStay}
              fallback={<span class="stop__num">{props.sequence}</span>}
            >
              <ModeGlyph mode="lodging" />
            </Show>
          </div>
          <Show when={hasPlaceDetail(props.place)}>
            <button
              type="button"
              class="stop__disclose"
              aria-expanded={detailOpen()}
              aria-label={detailOpen() ? "Hide details" : "Show details"}
              onClick={() => setDetailOpen((v) => !v)}
            >
              <span class="stop__chevron" classList={{ "is-open": detailOpen() }} />
            </button>
          </Show>
        </div>

        <div class="stop__body">
          <div class="stop__head">
            <a
              class="stop__name"
              href={buildGoogleMapsUrl(props.place)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {props.place.name}
            </a>
            <TimeLabel start={props.item.startTime} end={props.item.endTime} />
          </div>
          <Show when={meta()}>{(text) => <p class="stop__meta">{text()}</p>}</Show>
          <Show when={cleanAddress(props.place.address)}>
            {(where) => <p class="stop__where">{where()}</p>}
          </Show>
          <StatusPill status={props.item.status} />
          <Notes text={props.item.notes} />
          <PlaceDetail place={props.place} weekday={props.weekday} open={detailOpen()} />
        </div>
        <PlacePhoto place={props.place} />
      </article>
    </li>
  );
}

/**
 * The in-route form of a flight: the full card lives in the day summary, so
 * here it only has to say "this hop is the flight, not a ground route".
 */
export function FlightConnector(props: { item: FlightItem }) {
  const detail = () =>
    [props.item.departTime, props.item.arriveTime].filter(Boolean).join(" – ");

  return (
    <li class="travel travel--flight">
      <span class="travel__glyph">
        <ModeGlyph mode="flight" />
      </span>
      <span class="travel__mode">
        {[props.item.airline, props.item.flightNumber].filter(Boolean).join(" ") || "Flight"}
      </span>
      <Show when={detail()}>
        <span class="travel__detail">{detail()}</span>
      </Show>
    </li>
  );
}

export function FlightRow(props: { item: FlightItem }) {
  const [open, setOpen] = createSignal(false);
  const code = () =>
    [props.item.airline, props.item.flightNumber].filter(Boolean).join(" ") || "Flight";
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

  return (
    <li class="stop-item">
      <article class="card card--flight">
        <div class="card__kind">
          <ModeGlyph mode="flight" />
          <span>{code()}</span>
          <Show when={props.item.confirmationNumber}>
            {(reference) => <span class="card__ref">{reference()}</span>}
          </Show>
        </div>

        <div class="flight-legs">
          <div class="flight-end">
            <span class="flight-end__time">{props.item.departTime ?? "—"}</span>
            <span class="flight-end__code">{props.item.departAirport}</span>
            <span class="flight-end__city">{props.item.departCity}</span>
          </div>

          <div class="flight-path" aria-hidden="true">
            <span class="flight-path__line" />
            <ModeGlyph mode="flight" />
            <span class="flight-path__line" />
          </div>

          <div class="flight-end flight-end--arrive">
            <span class="flight-end__time">
              {props.item.arriveTime ?? "—"}
              <Show when={overnight()}>
                <sup class="flight-end__plus" title="Arrives the next day">
                  +1
                </sup>
              </Show>
            </span>
            <span class="flight-end__code">{props.item.arriveAirport}</span>
            <span class="flight-end__city">{props.item.arriveCity}</span>
          </div>
        </div>

        <StatusPill status={props.item.status} />

        <Show when={hasDetail()}>
          <button
            type="button"
            class="text-button"
            aria-expanded={open()}
            onClick={() => setOpen((v) => !v)}
          >
            {open() ? "Less" : "Booking"}
          </button>
        </Show>
        <Show when={open()}>
          <div class="card__detail">
            <Show when={props.item.travellerNames?.length}>
              <p class="card__detail-row">
                <span class="card__detail-label">Travellers</span>
                {props.item.travellerNames?.join(", ")}
              </p>
            </Show>
            <Show when={!noteRestatesNames(props.item.notes, props.item.travellerNames)}>
              <Notes text={props.item.notes} />
            </Show>
          </div>
        </Show>
      </article>
    </li>
  );
}

export function NoteRow(props: { item: NoteItem }) {
  return (
    <li class="note-item">
      <p class="note-text">{formatArrows(props.item.text)}</p>
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
  const expandable = () =>
    Boolean(
      props.item.confirmationNumber ||
        props.item.phone ||
        props.item.website ||
        props.item.notes ||
        props.item.travellerNames?.length ||
        props.place?.address,
    );

  return (
    <div
      class="lodging-band"
      classList={{
        "lodging-band--in": role() === "check-in",
        "lodging-band--out": role() === "check-out",
      }}
    >
      <button
        type="button"
        class="lodging-band__summary"
        aria-expanded={expandable() ? open() : undefined}
        disabled={!expandable()}
        onClick={() => setOpen((v) => !v)}
      >
        <span class="lodging-band__phase">{phaseLabel()}</span>
        <span class="lodging-band__name">{props.item.name}</span>
        <Show when={nightsLabel()}>
          {(label) => <span class="lodging-band__nights">{label()}</span>}
        </Show>
        <Show when={expandable()}>
          <span class="lodging-band__chevron" classList={{ "is-open": open() }} aria-hidden="true" />
        </Show>
      </button>

      <Show when={open()}>
        <div class="lodging-band__detail">
          <dl class="lodging-band__dates">
            <Show when={props.item.checkInDate}>
              {(date) => (
                <div>
                  <dt>Check in</dt>
                  <dd>{formatLodgingDate(date())}</dd>
                </div>
              )}
            </Show>
            <Show when={props.item.checkOutDate}>
              {(date) => (
                <div>
                  <dt>Check out</dt>
                  <dd>{formatLodgingDate(date())}</dd>
                </div>
              )}
            </Show>
            <Show when={nightsLabel()}>
              {(label) => (
                <div>
                  <dt>Stay</dt>
                  <dd>{label()}</dd>
                </div>
              )}
            </Show>
          </dl>

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
          <Show when={cleanAddress(props.place?.address)}>
            {(where) => (
              <p class="card__detail-row">
                <span class="card__detail-label">Where</span>
                {where()}
              </p>
            )}
          </Show>

          <Notes text={props.item.notes} />

          <div class="lodging-band__actions">
            <Show when={props.place}>
              {(place) => (
                <a
                  class="text-button"
                  href={buildGoogleMapsUrl(place())}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Maps
                </a>
              )}
            </Show>
            <Show when={props.item.phone}>
              {(phone) => (
                <a class="text-button" href={`tel:${phone().replace(/\s+/g, "")}`}>
                  Call
                </a>
              )}
            </Show>
            <Show when={props.item.website}>
              {(site) => (
                <a class="text-button" href={site()} target="_blank" rel="noopener noreferrer">
                  Website
                </a>
              )}
            </Show>
          </div>
        </div>
      </Show>
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
        <RouteLegRow leg={leg} />
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
