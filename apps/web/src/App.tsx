import {
  For,
  Match,
  Show,
  Switch,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { DaySection } from "./components/DaySection";
import { DayTabs } from "./components/DayTabs";
import { observeActiveDay, pinOnScreen, scrollToDay } from "./lib/active-day";
import { formatArrows, formatTripRange } from "./lib/format";
import { loadTripBundle, tripIsEncrypted } from "./lib/load-trip";
import { forgetPassphrase, readPassphrase, rememberPassphrase } from "./lib/passphrase";
import { WrongPassphraseError } from "./lib/trip-crypto";
import { Unlock } from "./components/Unlock";
import { collectStays } from "./lib/lodging";
import { AppUpdate } from "./components/AppUpdate";
import { CollapseAll } from "./components/CollapseAll";
import { RefreshTrip } from "./components/RefreshTrip";
import { isDayCollapsed, setDayCollapsed } from "./lib/collapsed-days";
import { ThemeToggle } from "./components/ThemeToggle";
import { indexRouteLegs } from "./lib/route-legs";
import { withLiveBoards } from "./lib/live-departures";

export default function App() {
  /*
   * The passphrase is the decryption key, so nothing loads without one.
   *
   * A remembered passphrase is validated before it is adopted. Letting the
   * resource discover it was stale instead meant `trip.error` lingered while
   * the next fetch was in flight, and the clearing logic then wiped the
   * passphrase the reader had just typed.
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
  const [tabLocked, setTabLocked] = createSignal(false);
  let unlockTimer: ReturnType<typeof setTimeout> | undefined;
  let stopObserver: (() => void) | undefined;

  createEffect(() => {
    const bundle = trip();
    if (!bundle) return;

    const ids = bundle.days.map((day) => day.id);
    // Untracked: reading it here re-ran this effect on every scroll update,
    // rebuilding the observer, which then reported day one again.
    if (!untrack(activeDayId) && ids[0]) setActiveDayId(ids[0]);

    stopObserver?.();
    stopObserver = undefined;

    const frame = requestAnimationFrame(() => {
      stopObserver = observeActiveDay(
        ids,
        (id) => {
          if (!tabLocked()) setActiveDayId(id);
        },
        { topOffsetPx: 108 },
      );
    });

    onCleanup(() => {
      cancelAnimationFrame(frame);
      stopObserver?.();
      stopObserver = undefined;
    });
  });

  onCleanup(() => {
    if (unlockTimer) clearTimeout(unlockTimer);
  });

  /**
   * Make a day the active one, holding off the scroll-spy while the page
   * scrolls there so the pill does not flick through the days in between.
   */
  const holdSpy = (releaseAfterMs?: number) => {
    setTabLocked(true);
    if (unlockTimer) clearTimeout(unlockTimer);
    if (releaseAfterMs !== undefined) {
      unlockTimer = setTimeout(() => setTabLocked(false), releaseAfterMs);
    }
  };

  /**
   * Fold or open every day without losing your place: the day you are on keeps
   * its header where it is while the days around it change height, and stays
   * the active tab. Without this the page shrinks to a few headers and the
   * spy reads "scrolled to the bottom" as the last day.
   */
  const keepActiveDay = () => {
    const section = document.getElementById(activeDayId());
    holdSpy(900);
    if (!section) return;
    if (section.getBoundingClientRect().top < 0) {
      section.scrollIntoView({ block: "start", behavior: "instant" });
    }
    pinOnScreen(section, 700);
  };

  /** A header tap: the page is already there, so only a short hold. */
  const focusDay = (dayId: string) => {
    setActiveDayId(dayId);
    holdSpy(700);
  };

  /**
   * A tab tap opens its day; tapping the tab of the day already open and in
   * focus folds it again.
   */
  const selectDay = (dayId: string) => {
    const day = trip()?.days.find((candidate) => candidate.id === dayId);
    const open = day ? !isDayCollapsed(day.id, day.date) : false;
    const closing = dayId === activeDayId() && open;
    setActiveDayId(dayId);
    // Hold until the page has actually arrived, however far that is.
    holdSpy();
    if (closing) {
      // Closing the day you are in: bring its header up first, then fold, so
      // the page shrinks below a header that stays put instead of under you.
      const section = document.getElementById(dayId);
      // scroll-margin-top keeps it clear of the sticky tabs.
      if (section && section.getBoundingClientRect().top < 0) {
        section.scrollIntoView({ block: "start", behavior: "instant" });
      }
      setDayCollapsed(dayId, true);
      holdSpy(500);
      return;
    }
    setDayCollapsed(dayId, false);
    void scrollToDay(dayId).then(() => holdSpy(150));
  };

  return (
    <div class="app-shell">
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
                  <div class="trip-header__actions">
                    <RefreshTrip passphrase={passphrase() ?? ""} />
                    <CollapseAll days={data.days} onToggle={keepActiveDay} />
                    <ThemeToggle />
                  </div>
                  <div class="trip-header__inner">
                    <p class="trip-header__eyebrow">Itinerary</p>
                    <h1 class="trip-header__title">{formatArrows(data.trip.title)}</h1>
                    <p class="trip-header__range">
                      {formatTripRange(data.trip.startDate, data.trip.endDate)}
                    </p>
                  </div>
                </header>
                <DayTabs
                  days={data.days}
                  activeDayId={activeDayId() || data.days[0]?.id || ""}
                  onSelect={selectDay}
                />

                <main class="itinerary" aria-label="Trip itinerary">
                  <For each={data.days}>
                    {(day, index) => (
                      <DaySection
                        day={day}
                        bundle={shown() ?? data}
                        index={index()}
                        stays={stays}
                        legIndex={legIndex}
                        stayPlaceIds={stayPlaceIds}
                        onFocus={focusDay}
                      />
                    )}
                  </For>
                  <footer class="itinerary-footer">
                    <p>
                      Revision <code>{data.revision}</code>
                    </p>
                    <Show when={import.meta.env.PROD}>
                      <AppUpdate />
                    </Show>
                  </footer>
                </main>
              </>
            );
          }}
        </Match>
      </Switch>
    </div>
  );
}
