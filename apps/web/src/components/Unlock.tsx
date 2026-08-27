import { createSignal } from "solid-js";
import { Show } from "solid-js";

/**
 * First-run gate. It guards the *decryption key*, not the UI — without the
 * passphrase the payload on this device is ciphertext and stays that way.
 */
export function Unlock(props: { onUnlock: (passphrase: string) => Promise<void> }) {
  const [value, setValue] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    const passphrase = value().trim();
    if (!passphrase || busy()) return;

    setBusy(true);
    setError("");
    try {
      await props.onUnlock(passphrase);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the trip.");
      setBusy(false);
    }
  };

  return (
    <div class="unlock">
      <form class="unlock__card" onSubmit={submit}>
        <p class="unlock__eyebrow">Travel Companion</p>
        <h1 class="unlock__title">Enter the trip passphrase</h1>
        <p class="unlock__body">
          Asked once on this device. The itinerary is stored encrypted and
          unlocks in your browser.
        </p>

        <input
          class="unlock__input"
          type="password"
          autocomplete="current-password"
          inputmode="text"
          placeholder="Passphrase"
          aria-label="Trip passphrase"
          value={value()}
          onInput={(event) => setValue(event.currentTarget.value)}
          disabled={busy()}
        />

        <Show when={error()}>
          {(message) => (
            <p class="unlock__error" role="alert">
              {message()}
            </p>
          )}
        </Show>

        <button class="btn btn--primary" type="submit" disabled={busy() || !value().trim()}>
          {busy() ? "Opening…" : "Open trip"}
        </button>
      </form>
    </div>
  );
}
