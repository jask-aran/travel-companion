// What Cloudflare loads. It must export only the handler: the runtime refuses
// to start a function whose other exports aren't handlers (index.ts exports
// constants for the tests).
export { default } from "./index.js";
