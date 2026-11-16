import { createSignal, Show } from "solid-js";
import { agentLink, agentToken } from "../lib/agent-link";
import { success } from "../lib/haptics";

declare const __TRIP_BASE__: string;
const base = typeof __TRIP_BASE__ === "string" ? __TRIP_BASE__ : "/";

/**
 * The address a traveller gives their own chat agent (a custom connector in
 * Claude or ChatGPT) so it can read this trip. The link is the secret: it is
 * made from the passphrase that unlocked this device, so anyone who can open
 * the trip can make it, and it opens the whole trip to whoever holds it.
 */
export function AgentLink(props: { passphrase: string }) {
  const [message, setMessage] = createSignal("");
  /** Set only when the clipboard refused, so the link can be copied by hand. */
  const [link, setLink] = createSignal("");

  const copy = async () => {
    const address = agentLink(
      new URL(base, location.origin).href,
      await agentToken(props.passphrase),
    );
    try {
      await navigator.clipboard.writeText(address);
      success();
      setLink("");
      setMessage("Copied. Paste it as the MCP server URL of a custom connector.");
    } catch {
      setLink(address);
      setMessage("Copy this as the MCP server URL of a custom connector:");
    }
  };

  return (
    <div class="refresh-trip">
      <p>Ask Claude or ChatGPT about this trip</p>
      <button type="button" class="text-button" onClick={() => void copy()}>
        Copy connector link
      </button>
      <Show when={message()}>
        <p role="status">{message()}</p>
      </Show>
      <Show when={link()}>
        <code class="agent-link">{link()}</code>
      </Show>
    </div>
  );
}
