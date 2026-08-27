import { createSignal } from "solid-js";

/**
 * Three states, matching how the rest of the web behaves: an explicit choice
 * is stamped on the root element and persisted; with no choice stored the
 * system preference decides and no attribute is set.
 */
export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "travel-companion:theme";

function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // Private browsing and blocked site data both throw on access.
    return "system";
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

const [theme, setThemeSignal] = createSignal<Theme>(readStored());

apply(theme());

export { theme };

export function setTheme(next: Theme): void {
  setThemeSignal(next);
  apply(next);
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Persisting is a convenience; the choice still applies for this session.
  }
}

/** True when dark is actually showing, whether chosen or inherited. */
export function isDark(): boolean {
  const current = theme();
  if (current !== "system") return current === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
