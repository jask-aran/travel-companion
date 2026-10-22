/**
 * A manual "get the latest app" for when the automatic update does not land.
 *
 * `registerSW` with autoUpdate already reloads once a new service worker takes
 * control. What can stall is the check itself: the browser may answer it from
 * an HTTP-cached `sw.js` (the custom domain has sent a 4 h max-age). Fetching
 * the script with `cache: "reload"` replaces that cached copy first, so the
 * following `update()` sees what is actually deployed.
 */
let registration: ServiceWorkerRegistration | undefined;
let scriptUrl: string | undefined;

export function rememberRegistration(
  swUrl: string,
  registered: ServiceWorkerRegistration | undefined,
): void {
  scriptUrl = swUrl;
  registration = registered;
}

/**
 * Check again whenever the app comes back to the foreground. A home-screen
 * app is resumed far more often than it is loaded, and the browser's own
 * check only runs on a load. Throttled, since switching apps is frequent.
 */
const RESUME_CHECK_INTERVAL_MS = 60_000;
let lastCheck = 0;

export function checkForUpdatesOnResume(): void {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastCheck < RESUME_CHECK_INTERVAL_MS) return;
    void checkForAppUpdate().catch(() => undefined);
  });
}

export type UpdateResult = "updating" | "current" | "unavailable";

export async function checkForAppUpdate(): Promise<UpdateResult> {
  if (!registration || !scriptUrl) return "unavailable";
  lastCheck = Date.now();
  await fetch(scriptUrl, { cache: "reload" }).catch(() => undefined);
  await registration.update();
  // A worker left waiting by an older build (one without skipWaiting) is told
  // to take over; the generated worker listens for exactly this message.
  registration.waiting?.postMessage({ type: "SKIP_WAITING" });
  if (!registration.installing && !registration.waiting) return "current";
  // autoUpdate reloads when the new worker takes control. If that event is
  // missed, reload anyway: the worst case is reloading into the same version.
  setTimeout(() => location.reload(), 8000);
  return "updating";
}
