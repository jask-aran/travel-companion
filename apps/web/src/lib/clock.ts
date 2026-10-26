import { createSignal } from "solid-js";

/**
 * The phone's own date and time, as the trip's days are read on it: abroad,
 * the phone is on local time. Refreshed each half minute and whenever the app
 * comes back to the front, so "today" and "next up" move on by themselves.
 */
export type Clock = { date: string; time: string };

function read(): Clock {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString();
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

const [clock, setClock] = createSignal<Clock>(read(), {
  equals: (a, b) => a.date === b.date && a.time === b.time,
});

if (typeof window !== "undefined") {
  setInterval(() => setClock(read()), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") setClock(read());
  });
}

export { clock };
