import { For, Show, createMemo, createSignal } from "solid-js";
import type { TripBundle } from "@travel-companion/trip-schema";
import { URGENT_DAYS, daysUntil, tripFlights, tripPlace, tripStays, type StayBooking } from "../lib/bookings";
import { formatDayHeading, formatTabDayMonth } from "../lib/format";
import { success } from "../lib/haptics";
import { Icon } from "./Icon";
import { ModeGlyph } from "./ItemCards";

/**
 * The Bookings page: the trip at a glance (each stay sized by its nights,
 * and where today sits), then every flight and stay with its reference ready
 * to copy, rooms, and free-cancellation deadlines. Reached from the first
 * of the day tabs; tapping a stay or flight opens its day.
 */
export function BookingsPage(props: { bundle: TripBundle; today: string; onSelectDay: (dayId: string) => void }) {
  const flights = createMemo(() => tripFlights(props.bundle));
  const stays = createMemo(() => tripStays(props.bundle));
  return (
    <section class="bookings" aria-label="Bookings">
      <TripGlance bundle={props.bundle} stays={stays()} flightDates={new Set(flights().map((flight) => flight.date))} today={props.today} onSelectDay={props.onSelectDay} />
      <div class="bookings__card">
        <h2 class="summary-label bookings__label">Flights</h2>
        <ul class="bookings__list">
          <For each={flights()}>
            {(flight) => (
              <li class="booking">
                <button type="button" class="booking__main" data-haptic="selection" onClick={() => props.onSelectDay(flight.dayId)}>
                  <span class="kind-badge kind-badge--flight" aria-hidden="true">
                    <ModeGlyph mode="flight" />
                  </span>
                  <span class="booking__text">
                    <strong class="booking__name booking__name--codes">{flight.route.join(" → ")}</strong>
                    <span class="booking__sub">
                      {[formatDayHeading(flight.date), flight.numbers.join(", "), flight.travellers && `${flight.travellers} travellers`].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </button>
                <Reference value={flight.ref} />
              </li>
            )}
          </For>
        </ul>
        <h2 class="summary-label bookings__label">Stays</h2>
        <ul class="bookings__list">
          <For each={stays()}>
            {(stay) => (
              <li class="booking">
                <button
                  type="button"
                  class="booking__main"
                  data-haptic="selection"
                  disabled={!stay.dayId}
                  onClick={() => stay.dayId && props.onSelectDay(stay.dayId)}
                >
                  <span class="kind-badge kind-badge--lodging" aria-hidden="true">
                    <ModeGlyph mode="lodging" />
                  </span>
                  <span class="booking__text">
                    <strong class="booking__name">{stay.name}</strong>
                    <span class="booking__sub">
                      {[`${formatTabDayMonth(stay.checkInDate)} → ${formatTabDayMonth(stay.checkOutDate)}`, `${stay.nights} night${stay.nights === 1 ? "" : "s"}`, stay.rooms && `${stay.rooms} room${stay.rooms === 1 ? "" : "s"}`]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <Deadline stay={stay} today={props.today} />
                  </span>
                </button>
                <Reference value={stay.ref} />
              </li>
            )}
          </For>
        </ul>
      </div>
    </section>
  );
}

/** A booking reference to copy, or a plain "No reference" where Wanderlog has none. */
function Reference(props: { value: string | undefined }) {
  const [copied, setCopied] = createSignal(false);
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      success();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // No clipboard: the reference is still there to read.
    }
  };
  return (
    <Show when={props.value} fallback={<span class="booking__ref booking__ref--none">No reference</span>}>
      {(value) => (
        <button type="button" class="booking__ref" aria-label={copied() ? `${value()} copied` : `Copy booking reference ${value()}`} onClick={() => void copy(value())}>
          <Show when={copied()} fallback={value()}>
            <Icon name="check" /> Copied
          </Show>
        </button>
      )}
    </Show>
  );
}

/** Free cancellation: red within URGENT_DAYS, quiet before then, and "ended" once past. */
function Deadline(props: { stay: StayBooking; today: string }) {
  return (
    <Show when={props.stay.cancelBy}>
      {(cancelBy) => {
        const days = () => daysUntil(props.today, cancelBy());
        const time = () => cancelBy().slice(11, 16);
        const when = () => `${formatDayHeading(cancelBy().slice(0, 10))}${time() ? ` ${time()}` : ""}`;
        return (
          <span
            class="booking__deadline"
            classList={{ "booking__deadline--urgent": days() >= 0 && days() <= URGENT_DAYS, "booking__deadline--past": days() < 0 }}
            title={props.stay.cancelPolicy}
          >
            <Show when={days() >= 0} fallback={<>Free cancellation ended {when()}</>}>
              Free cancellation until {when()}
              <Show when={days() <= URGENT_DAYS}>
                <span class="booking__countdown">{days() === 0 ? "today" : `${days()} day${days() === 1 ? "" : "s"}`}</span>
              </Show>
            </Show>
          </span>
        );
      }}
    </Show>
  );
}

/** Each stay as a stretch of a bar sized by its nights, then named chips; today marked. */
function TripGlance(props: { bundle: TripBundle; stays: StayBooking[]; flightDates: Set<string>; today: string; onSelectDay: (dayId: string) => void }) {
  const place = () => tripPlace(props.bundle, props.today);
  const current = () => props.stays.find((stay) => stay.checkInDate <= props.today && props.today < stay.checkOutDate);
  const totalNights = () => props.stays.reduce((sum, stay) => sum + stay.nights, 0) || 1;
  /** Today's position along the bar, at midday. */
  const marker = () => {
    const first = props.stays[0];
    if (!first || place().kind !== "during") return undefined;
    return Math.min(100, Math.max(0, ((daysUntil(first.checkInDate, props.today) + 0.5) / totalNights()) * 100));
  };
  const status = () => {
    const where = place();
    if (where.kind === "before") return <>Starts in <strong>{where.days} day{where.days === 1 ? "" : "s"}</strong></>;
    if (where.kind === "after") return <>Trip over</>;
    return (
      <>
        Day <strong>{where.day}</strong> of {where.of}
        <Show when={current()?.city}>{(city) => <> · {city()}</>}</Show>
      </>
    );
  };
  return (
    <div class="trip-glance">
      <p class="trip-glance__status">{status()}</p>
      <div class="trip-glance__bar" aria-hidden="true">
        <For each={props.stays}>
          {(stay) => <i class="trip-glance__stretch" classList={{ "trip-glance__stretch--now": stay === current() }} style={{ "flex-grow": stay.nights }} />}
        </For>
        <Show when={marker()}>{(left) => <b class="trip-glance__today" style={{ left: `${left()}%` }} />}</Show>
      </div>
      <div class="trip-glance__chips">
        <For each={props.stays}>
          {(stay) => (
            <>
              <Show when={props.flightDates.has(stay.checkInDate)}>
                <span class="trip-glance__fly" aria-label="Flight">
                  <ModeGlyph mode="flight" />
                </span>
              </Show>
              <button
                type="button"
                class="trip-glance__chip"
                classList={{ "trip-glance__chip--now": stay === current() }}
                data-haptic="selection"
                disabled={!stay.dayId}
                aria-label={`${stay.city ?? stay.name}, ${stay.nights} nights from ${formatDayHeading(stay.checkInDate)}: open the day`}
                onClick={() => stay.dayId && props.onSelectDay(stay.dayId)}
              >
                {stay.city ?? stay.name} <small>{stay.nights}n</small>
              </button>
            </>
          )}
        </For>
        {/* The flight home, off the last stay. */}
        <Show when={props.stays.at(-1) && props.flightDates.has(props.stays.at(-1)!.checkOutDate)}>
          <span class="trip-glance__fly" aria-label="Flight">
            <ModeGlyph mode="flight" />
          </span>
        </Show>
      </div>
      <p class="trip-glance__ends">
        <span>{formatDayHeading(props.bundle.trip.startDate)}</span>
        <span>{formatDayHeading(props.bundle.trip.endDate)}</span>
      </p>
    </div>
  );
}
