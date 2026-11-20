import { createSignal, onCleanup } from "solid-js";
import type { MapTheme } from "./map-style.js";
import { theme } from "./theme.js";

/** The theme actually showing, following the system while the app's theme is "system". For maps, which draw their own colours. */
export function useMapTheme(): () => MapTheme {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(query.matches);
  const onChange = () => setSystemDark(query.matches);
  query.addEventListener("change", onChange);
  onCleanup(() => query.removeEventListener("change", onChange));
  return () => {
    const chosen = theme();
    return chosen === "system" ? (systemDark() ? "dark" : "light") : chosen;
  };
}
