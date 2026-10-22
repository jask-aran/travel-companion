import { createSignal, Show } from "solid-js";
import { checkForAppUpdate } from "../lib/app-update";

declare const __APP_BUILT_AT__: string;

const builtAt = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(__APP_BUILT_AT__));

/** The app shell's own update, separate from the trip data refresh. */
export function AppUpdate() {
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const check = async () => {
    if (busy()) return;
    setBusy(true);
    setMessage("Checking…");
    try {
      const result = await checkForAppUpdate();
      if (result === "updating") {
        setMessage("New version found. Reloading…");
        return;
      }
      setMessage(result === "current" ? "This is the latest version." : "Updates are not available here.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Update check failed");
    }
    setBusy(false);
  };

  return (
    <div class="refresh-trip">
      <p>App built {builtAt}</p>
      <button type="button" class="text-button" disabled={busy()} onClick={() => void check()}>
        Get latest app version
      </button>
      <Show when={message()}>
        <p>{message()}</p>
      </Show>
    </div>
  );
}
