/**
 * The Day map is a scroll-snap point (styles.css: `.day-map--snap`), so a
 * person scrolling near it settles into map mode. When the app moves the page
 * itself (changing day, folding days, landing on a day), that snap must not
 * pull the page onto the map, so it is switched off for the move.
 */
let holds = 0;

function apply(): void {
  document.documentElement.classList.toggle("map-snap-off", holds > 0);
}

/** Turn the snap off until the returned release runs, or `ms` passes. */
export function holdMapSnap(ms = 1500): () => void {
  holds += 1;
  apply();
  let released = false;
  // Each hold has its own timer, so one hold can never cancel another's expiry.
  const timer = setTimeout(() => release(), ms);
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    holds -= 1;
    apply();
  };
  return release;
}
