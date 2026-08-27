import { Show } from "solid-js";
import { isDark, setTheme } from "../lib/theme";

/**
 * Flips between light and dark. Choosing either pins that choice; the app
 * follows the system preference until someone does.
 */
export function ThemeToggle() {
  const next = () => (isDark() ? "light" : "dark");

  return (
    <button
      type="button"
      class="theme-toggle"
      onClick={() => setTheme(next())}
      aria-label={`Switch to ${next()} theme`}
      title={`Switch to ${next()} theme`}
    >
      <Show
        when={isDark()}
        fallback={
          /* Moon: offer the dark theme while the light one is showing. */
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </svg>
        }
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4" />
        </svg>
      </Show>
    </button>
  );
}
