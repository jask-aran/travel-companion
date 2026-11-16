import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BREAKER_OPEN_MS,
  GOOGLE_DAILY_REQUESTS,
  NAVITIME_MONTHLY_REQUESTS,
  PROVIDER_TIMEOUT_MS,
  ProviderRefused,
  createGuard,
  forgetGuardMemory,
  guardStatus,
} from "../workers/refresh/guard.js";

const GOOGLE = "https://places.googleapis.com/v1/places/abc";
const NAVITIME = "https://navitime-route-totalnavi.p.rapidapi.com/route_transit?start=1,2";

function setup(status = 200) {
  const kv = new Map<string, string>();
  const store = { get: vi.fn(async (key: string) => kv.get(key) ?? null), put: vi.fn(async (key: string, value: string) => void kv.set(key, value)) };
  const provider = vi.fn(async () => new Response("x", { status }));
  let clock = Date.parse("2026-12-01T10:00:00Z");
  /** A new invocation (and, with `isolate`, a new isolate that knows only KV). */
  const guard = (isolate = false) => {
    if (isolate) forgetGuardMemory();
    return createGuard(store, { now: () => clock, fetch: provider });
  };
  const send = async (url: string, isolate = false) => guard(isolate).fetch(url).then((response) => response.status, (error: unknown) => error);
  return { kv, store, provider, send, guard, advance: (ms: number) => void (clock += ms) };
}

beforeEach(() => {
  forgetGuardMemory();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the provider guard", () => {
  it("keeps the last refusal and the count for ship:check", async () => {
    const { store, send } = setup(403);
    const at = Date.parse("2026-12-01T10:00:00Z");
    expect(await guardStatus(store, at)).toEqual({
      google: { used: 0, cap: GOOGLE_DAILY_REQUESTS, period: "2026-12-01" },
      navitime: { used: 0, cap: NAVITIME_MONTHLY_REQUESTS, period: "2026-12" },
    });
    expect(await send(GOOGLE)).toBe(403);
    const status = await guardStatus(store, at);
    expect(status.google).toEqual({
      used: 1, cap: GOOGLE_DAILY_REQUESTS, period: "2026-12-01",
      closedUntil: new Date(at + BREAKER_OPEN_MS).toISOString(),
      refused: { status: 403, at: "2026-12-01T10:00:00.000Z", said: "x" },
    });
    expect((await guardStatus(store, at + BREAKER_OPEN_MS)).google.closedUntil).toBeUndefined();
    expect(status.navitime.refused).toBeUndefined();
  });

  for (const [provider, url] of [["google", GOOGLE], ["navitime", NAVITIME]] as const) {
    for (const status of [403, 429]) {
      it(`stops asking ${provider} for an hour after a ${status}, in every isolate, then asks again`, async () => {
        const { provider: upstream, send, advance } = setup(status);
        expect(await send(url)).toBe(status);
        expect(await send(url)).toBeInstanceOf(ProviderRefused);
        expect(await send(url, true)).toBeInstanceOf(ProviderRefused);
        advance(BREAKER_OPEN_MS - 1);
        expect(await send(url)).toBeInstanceOf(ProviderRefused);
        expect(upstream).toHaveBeenCalledTimes(1);
        advance(1);
        expect(await send(url)).toBe(status);
        expect(upstream).toHaveBeenCalledTimes(2);
      });
    }
  }

  it("keeps asking after a 500 (the daily budget bounds those)", async () => {
    const { provider, send } = setup(500);
    await send(GOOGLE);
    await send(GOOGLE);
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it(`stops Google at ${GOOGLE_DAILY_REQUESTS} requests a UTC day, across isolates, and starts again the next day`, async () => {
    const { kv, provider, send, guard, advance } = setup();
    kv.set("guard/google/2026-12-01", String(GOOGLE_DAILY_REQUESTS - 2));
    const one = guard(true);
    expect(await Promise.all([one.fetch(GOOGLE), one.fetch(GOOGLE)]).then((all) => all.map((response) => response.status))).toEqual([200, 200]);
    expect(kv.get("guard/google/2026-12-01")).toBe(String(GOOGLE_DAILY_REQUESTS));
    expect(await send(GOOGLE)).toBeInstanceOf(ProviderRefused);
    expect(await send(GOOGLE, true)).toBeInstanceOf(ProviderRefused);
    expect(await send(NAVITIME)).toBe(200);
    expect(provider).toHaveBeenCalledTimes(3);
    advance(14 * 3_600_000);
    expect(await send(GOOGLE)).toBe(200);
    expect(kv.get("guard/google/2026-12-02")).toBe("1");
  });

  it("sends nothing when the day's count can't be read or written, or the host is unknown", async () => {
    const { store, provider, send } = setup();
    store.put.mockRejectedValueOnce(new Error("KV write limit"));
    expect(await send(GOOGLE)).toBeInstanceOf(ProviderRefused);
    store.get.mockRejectedValueOnce(new Error("KV down"));
    expect(await send(GOOGLE, true)).toBeInstanceOf(ProviderRefused);
    expect(await send("https://example.com/anything")).toBeInstanceOf(ProviderRefused);
    expect(provider).not.toHaveBeenCalled();
  });

  for (const [provider, url, key, cap] of [
    ["Google", GOOGLE, "guard/google/2026-12-01", GOOGLE_DAILY_REQUESTS],
    ["NAVITIME", NAVITIME, "guard/navitime/2026-12", NAVITIME_MONTHLY_REQUESTS],
  ] as const) {
    it(`sends only what is left of ${provider}'s budget when many requests start at once`, async () => {
      const { kv, provider: upstream, guard } = setup();
      kv.set(key, String(cap - 2));
      const one = guard(true);
      const sent = await Promise.all(Array.from({ length: 5 }, () => one.fetch(url).then(() => "sent", () => "refused")));
      expect(sent.filter((outcome) => outcome === "sent")).toHaveLength(2);
      expect(upstream).toHaveBeenCalledTimes(2);
      expect(kv.get(key)).toBe(String(cap));
    });
  }

  it("counts NAVITIME by calendar month, at 250", async () => {
    expect(NAVITIME_MONTHLY_REQUESTS).toBe(250);
    const { kv, provider, send, advance } = setup();
    kv.set("guard/navitime/2026-12", String(NAVITIME_MONTHLY_REQUESTS));
    expect(await send(NAVITIME, true)).toBeInstanceOf(ProviderRefused);
    advance(31 * 86_400_000);
    expect(await send(NAVITIME)).toBe(200);
    expect(kv.get("guard/navitime/2027-01")).toBe("1");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("takes KV's count when it writes, so another isolate's spent day stops this one", async () => {
    const { kv, provider, guard } = setup();
    const one = guard(true);
    expect((await one.fetch(GOOGLE)).status).toBe(200);
    // Meanwhile another isolate spends the day.
    kv.set("guard/google/2026-12-01", String(GOOGLE_DAILY_REQUESTS));
    await expect(one.fetch(GOOGLE)).rejects.toBeInstanceOf(ProviderRefused);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("checks the breaker again just before sending", async () => {
    const { store } = setup();
    let called!: () => void;
    const firstSent = new Promise<void>((resolve) => (called = resolve));
    const upstream = vi.fn(async () => {
      called();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response("billing", { status: 403 });
    });
    const one = createGuard(store, { fetch: upstream, now: () => Date.parse("2026-12-01T10:00:00Z") });
    const first = one.fetch(GOOGLE);
    await firstSent;
    // The second request's count write is slow; the first's 403 lands during it.
    const get = store.get.getMockImplementation()!;
    store.get.mockImplementation(async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return get(key);
    });
    const second = one.fetch(GOOGLE);
    expect((await first).status).toBe(403);
    await expect(second).rejects.toMatchObject({ reason: "breaker" });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("writes the new day's count when the UTC day turns inside one invocation", async () => {
    const { kv, store, provider } = setup();
    let clock = Date.parse("2026-12-01T23:59:59Z");
    const one = createGuard(store, { now: () => clock, fetch: provider });
    await one.fetch(GOOGLE);
    clock += 2_000;
    await one.fetch(GOOGLE);
    expect(kv.get("guard/google/2026-12-01")).toBe("1");
    expect(kv.get("guard/google/2026-12-02")).toBe("1");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it(`gives up on a provider after ${PROVIDER_TIMEOUT_MS / 1000} s`, async () => {
    const { store } = setup();
    const real = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => real(20));
    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    const one = createGuard(store, { fetch: hanging });
    await expect(one.fetch(GOOGLE)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(PROVIDER_TIMEOUT_MS);
    expect(hanging).toHaveBeenCalledTimes(1);
  });
});
