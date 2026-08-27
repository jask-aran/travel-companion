/* @refresh reload */
import { render } from "solid-js/web";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import "./fonts.css";
import "./styles.css";

// Real installability needs a controlling service worker + HTTPS (Tailscale Serve).
registerSW({
  immediate: true,
});

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

render(() => <App />, root);
