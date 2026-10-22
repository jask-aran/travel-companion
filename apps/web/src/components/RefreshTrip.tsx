import { createSignal, onCleanup, Show } from "solid-js";
import { checkForAppUpdate } from "../lib/app-update";
import { failure, success } from "../lib/haptics";

declare const __TRIP_BASE__: string;
const base = typeof __TRIP_BASE__ === "string" ? __TRIP_BASE__ : "/";

/**
 * One button for "get me the latest": the trip from Wanderlog, then the app
 * shell. In production the Pages function pulls and re-encrypts; the trip
 * passphrase already unlocked this device, so it is the credential. In dev
 * the Vite plugin's hook reruns the local pull instead.
 */
export function RefreshTrip(props: { passphrase: string }) {
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hideTimer));

  const say = (text: string, linger = true) => {
    clearTimeout(hideTimer);
    setMessage(text);
    if (linger) hideTimer = setTimeout(() => setMessage(""), 4000);
  };

  const pullTrip = async (): Promise<boolean> => {
    if (!import.meta.env.PROD) {
      const response = await fetch(`${base}__trip/refresh`);
      if (!response.ok) throw new Error(`Refresh failed (${response.status})`);
      return true;
    }
    const response = await fetch(`${base}api/refresh`, {
      method: "POST",
      headers: { Authorization: `Bearer ${props.passphrase}` },
    });
    const body = (await response.json().catch(() => null)) as
      | { error?: string; changed?: boolean }
      | null;
    if (!response.ok) throw new Error(body?.error ?? `Refresh failed (${response.status})`);
    return body?.changed !== false;
  };

  const refresh = async () => {
    if (busy()) return;
    setBusy(true);
    say("Pulling Wanderlog…", false);
    try {
      const tripChanged = await pullTrip();
      const app = await checkForAppUpdate().catch(() => "unavailable" as const);
      if (app === "updating") {
        say("New app version. Reloading…", false);
        return;
      }
      if (tripChanged) {
        success();
        await caches.delete("trip-bundle").catch(() => false);
        say("Updated. Reloading…", false);
        location.reload();
        return;
      }
      success();
      say("Already up to date.");
    } catch (error) {
      failure();
      say(error instanceof Error ? error.message : "Refresh failed");
    }
    setBusy(false);
  };

  return (
    <>
      <button
        type="button"
        class="header-button"
        classList={{ "is-busy": busy() }}
        disabled={busy()}
        onClick={() => void refresh()}
        aria-label="Update from Wanderlog"
        title="Update from Wanderlog"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
        </svg>
      </button>
      <Show when={message()}>
        <p class="toast" role="status">
          {message()}
        </p>
      </Show>
    </>
  );
}
