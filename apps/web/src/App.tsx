import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  onMount,
  untrack,
} from "solid-js";
import { DaySection } from "./components/DaySection";
import { CollapseRoute } from "./components/CollapseRoute";
import { WaveBackground } from "./components/WaveBackground";
import { DayTabs } from "./components/DayTabs";
import { formatArrows, formatTripRange } from "./lib/format";
import { loadTripBundle, tripIsEncrypted } from "./lib/load-trip";
import { forgetPassphrase, readPassphrase, rememberPassphrase } from "./lib/passphrase";
import { WrongPassphraseError } from "./lib/trip-crypto";
import { Unlock } from "./components/Unlock";
import { collectStays } from "./lib/lodging";
import { TripMenu } from "./components/TripMenu";
import { RefreshTrip } from "./components/RefreshTrip";
import { hasPagesFunction } from "./lib/pages-function";

/**
 * The refresh button needs the Pages function (dev reruns the local pull
 * instead, so it keeps the button). Chosen here, not with <Show>, so a static
 * build leaves the component out of the bundle. The trip menu decides the
 * connector link itself.
 */
const nothing = (_props: { passphrase: string; revision?: string }) => null;
const RefreshButton = !import.meta.env.PROD || hasPagesFunction ? RefreshTrip : nothing;
import { setDayCollapsed } from "./lib/collapsed-days";
import { ThemeToggle } from "./components/ThemeToggle";
import { indexRouteLegs } from "./lib/route-legs";
import { withLiveBoards } from "./lib/live-departures";
import { keepMediaOffline } from "./lib/offline-media";
import { clock } from "./lib/clock";
import { holdMapSnap } from "./lib/map-snap";

export default function App() {
  /*
   * The passphrase is the decryption key, so nothing loads without one. A
   * remembered one is checked before it is adopted, so a stale one cannot
   * clear the passphrase the reader has just typed.
   */
  const [passphrase, setPassphrase] = createSignal<string | undefined>(
    tripIsEncrypted ? undefined : "",
  );
  const [checkingStored, setCheckingStored] = createSignal(
    tripIsEncrypted && Boolean(readPassphrase()),
  );
  const [unlockError, setUnlockError] = createSignal("");
  const [trip] = createResource(passphrase, (secret) => loadTripBundle(secret));
  const shown = withLiveBoards(trip);
  // Once the itinerary is up, in the background: dev has no service worker to use the copies.
  createEffect(() => {
    const bundle = trip();
    if (!bundle || !import.meta.env.PROD) return;
    const start = () => void keepMediaOffline(bundle);
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 5000 });
    else setTimeout(start, 2000);
  });

  const isWrongPassphrase = (error: unknown) =>
    error instanceof WrongPassphraseError ||
    (error instanceof Error && error.name === "WrongPassphraseError");

  onMount(async () => {
    const stored = tripIsEncrypted ? readPassphrase() : undefined;
    if (!stored) return;
    try {
      await loadTripBundle(stored);
      setPassphrase(stored);
    } catch (error) {
      // Republishing under a new passphrase invalidates every stored one.
      if (isWrongPassphrase(error)) {
        forgetPassphrase();
        setUnlockError("That passphrase no longer opens this trip.");
      } else {
        // A saved copy would have answered even offline, so there is none yet.
        setUnlockError("Couldn't load the trip, and this device has no saved copy yet. Try again with signal.");
      }
    } finally {
      setCheckingStored(false);
    }
  });

  const unlock = async (candidate: string) => {
    // Decrypt before accepting it, so a wrong passphrase reports itself here.
    await loadTripBundle(candidate);
    rememberPassphrase(candidate);
    setUnlockError("");
    setPassphrase(candidate);
  };

  const [activeDayId, setActiveDayId] = createSignal("");
  // Selection owns the visible day; scrolling no longer changes the selection.
  createEffect(() => {
    const bundle = trip();
    if (!bundle) return;
    const selected = untrack(activeDayId);
    if (bundle.days.some((day) => day.id === selected)) return;
    const day = bundle.days.find((day) => day.date === untrack(clock).date) ?? bundle.days[0];
    if (!day) return;
    setDayCollapsed(day.id, false);
    setActiveDayId(day.id);
  });

  const selectDay = (dayId: string) => {
    if (dayId === activeDayId() || !trip()?.days.some((day) => day.id === dayId)) return;
    setDayCollapsed(dayId, false);
    setActiveDayId(dayId);
    // Read the new layout after Solid has replaced the previous day.
    holdMapSnap();
    requestAnimationFrame(() => {
      document.querySelector(".itinerary")?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  };

  return (
    <div class="app-shell">
      <WaveBackground />
      <Switch>
        <Match when={checkingStored()}>
          <div class="state-panel" role="status">
            <p class="state-panel__eyebrow">Travel Companion</p>
            <p class="state-panel__title">Opening itinerary…</p>
          </div>
        </Match>

        <Match when={tripIsEncrypted && !passphrase()}>
          <Unlock onUnlock={unlock} initialError={unlockError()} />
        </Match>

        <Match when={trip.loading}>
          <div class="state-panel" role="status">
            <p class="state-panel__eyebrow">Travel Companion</p>
            <p class="state-panel__title">Loading itinerary…</p>
          </div>
        </Match>

        <Match when={trip.error}>
          <div class="state-panel state-panel--error" role="alert">
            <p class="state-panel__eyebrow">Could not load trip</p>
            <p class="state-panel__title">
              {trip.error instanceof Error ? trip.error.message : "Unknown error"}
            </p>
            <p class="state-panel__body">
              Check your connection and reload. The itinerary is stored on this
              device, so this usually clears on its own.
            </p>
          </div>
        </Match>

        <Match when={trip()}>
          {(bundle) => {
            const data = bundle();
            const stays = collectStays(data);
            const legIndex = indexRouteLegs(data);
            const stayPlaceIds = new Set(
              stays.map((stay) => stay.placeId).filter((id): id is string => Boolean(id)),
            );
            return (
              <>
                {/*
                  * The tab bar is a sibling, not a child: `.trip-header` clips
                  * its overflow, which would make it the containing block for a
                  * sticky child and pin the tabs inside a header that scrolls
                  * away.
                  */}
                <header class="trip-header">
                  <div class="trip-header__inner">
                    <h1 class="trip-header__title">{formatArrows(data.trip.title)}</h1>
                    <p class="trip-header__range">
                      {formatTripRange(data.trip.startDate, data.trip.endDate)}
                    </p>
                    <div class="trip-header__actions">
                      <RefreshButton passphrase={passphrase() ?? ""} revision={data.revision} />
                      <Show when={data.days.find((day) => day.id === activeDayId())}>
                        {(day) => <CollapseRoute day={day()} />}
                      </Show>
                      <ThemeToggle />
                      <TripMenu revision={data.revision} passphrase={passphrase()} connector={hasPagesFunction} />
                    </div>
                  </div>
                </header>
                <DayTabs
                  days={data.days}
                  activeDayId={activeDayId() || data.days[0]?.id || ""}
                  today={clock().date}
                  onSelect={selectDay}
                />

                <main class="itinerary" aria-label="Trip itinerary">
                  <For each={data.days.filter((day) => day.id === activeDayId())}>
                    {(day) => (
                      <DaySection
                        day={day}
                        bundle={shown() ?? data}
                        index={data.days.findIndex((candidate) => candidate.id === day.id)}
                        stays={stays}
                        legIndex={legIndex}
                        stayPlaceIds={stayPlaceIds}
                      />
                    )}
                  </For>
                </main>
              </>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}
