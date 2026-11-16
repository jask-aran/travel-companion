import { Show } from "solid-js";
import { AgentLink } from "./AgentLink";
import { AppUpdate } from "./AppUpdate";

/**
 * The trip menu: the header's "More" button, for what isn't the trip itself,
 * like the app's own version and the connector link for a chat agent. It used to be the
 * itinerary's footer, which map mode buried under the Day map.
 *
 * A native popover: it sits in the top layer, so the header's clipping can't
 * cut it off, and it closes on Escape or a tap outside by itself.
 */
export function TripMenu(props: { revision: string; passphrase: string | undefined; connector: boolean }) {
  const id = "trip-menu";
  return (
    <>
      <button type="button" class="header-button" popovertarget={id} aria-label="More" title="More">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.4" />
          <circle cx="12" cy="12" r="1.4" />
          <circle cx="18.5" cy="12" r="1.4" />
        </svg>
      </button>
      <div id={id} class="trip-menu" popover="auto" role="dialog" aria-label="More">
        {/* Dev has no shell to update, so it shows the trip revision instead. */}
        <Show when={import.meta.env.PROD} fallback={<p>Revision <code>{props.revision}</code></p>}>
          <AppUpdate revision={props.revision} />
        </Show>
        {/* Only the live site's function has the connector, and a passphrase to make its link from. */}
        <Show when={import.meta.env.PROD && props.connector && props.passphrase}>
          {(secret) => <AgentLink passphrase={secret()} />}
        </Show>
      </div>
    </>
  );
}
