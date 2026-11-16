/**
 * The one door every Google and NAVITIME request in the function goes
 * through. Each request is checked before it is sent, and the checks fail
 * closed: when one can't be made (KV unreadable or unwritable), nothing is sent.
 *
 * - A circuit breaker per provider: a 403 or 429 means "billing, key or
 *   quota", which the next request won't fix, so the provider isn't asked at
 *   all for an hour. Kept in this isolate and in KV, for the other isolates.
 * - A budget per provider: Google's per UTC day, across photos, maps, boards
 *   and translations; NAVITIME's per calendar month (UTC). Each request is
 *   counted in this isolate's memory before anything is awaited, so
 *   concurrent requests can't all pass on one value, then the count is
 *   written to KV (merged with what KV holds) before the request is sent.
 * - A timeout on every request.
 * - A note of the last 403 or 429 per provider, kept in KV for
 *   `pnpm ship:check` to show (`guardStatus`).
 *
 * One guard per invocation (`createGuard`): it reads a provider's breaker
 * and count from KV once, the first time that provider is about to be
 * asked. KV cost per invocation and provider: 2 reads; per write of the
 * count (concurrent requests share one) a read and a write; at most one
 * breaker write.
 */

export type Provider = "google" | "navitime";

/**
 * Google requests a UTC day, all kinds together. A brake, not a ceiling:
 * the count is exact within one isolate, but isolates share it through KV,
 * which is last-write-wins (each takes the larger of its own count and KV's
 * when it loads and when it writes), so several isolates busy at once can
 * together pass it. The hard ceiling is the per-API daily quota set in the
 * Google Cloud console; set that too.
 */
export const GOOGLE_DAILY_REQUESTS = 300;
/**
 * NAVITIME requests a calendar month (UTC). The plan allows 500 a month,
 * counting failed requests, from the subscription date; any plan month
 * overlaps at most two calendar months, so 2 × 250 stays within it. A brake
 * across isolates in the same way as Google's; RapidAPI's own plan limit is
 * the ceiling.
 */
export const NAVITIME_MONTHLY_REQUESTS = 250;
/** How long a 403 or 429 keeps a provider from being asked. */
export const BREAKER_OPEN_MS = 60 * 60_000;
/** Longest wait for any one provider request. */
export const PROVIDER_TIMEOUT_MS = 8_000;
/**
 * How long a failed photo, map or board (a 5xx, a timeout, a bad answer) is
 * answered "unavailable" without asking again. The marker sits where the
 * item is kept (R2 for media, KV for boards).
 */
export const FAILURE_REMEMBERED_MS = 60 * 60_000;

export type GuardStore = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<unknown>;
};

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown instead of sending a request. */
export class ProviderRefused extends Error {
  constructor(readonly provider: Provider | undefined, readonly reason: "breaker" | "budget" | "store" | "host") {
    super(`${provider ?? "unknown host"} not asked: ${reason}`);
    this.name = "ProviderRefused";
  }
}

export function providerOf(url: string): Provider | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host.endsWith(".googleapis.com")) return "google";
  if (host === "navitime-route-totalnavi.p.rapidapi.com") return "navitime";
  return undefined;
}

const BUDGETS: Record<Provider, { cap: number; period: (ms: number) => string }> = {
  google: { cap: GOOGLE_DAILY_REQUESTS, period: (ms) => new Date(ms).toISOString().slice(0, 10) },
  navitime: { cap: NAVITIME_MONTHLY_REQUESTS, period: (ms) => new Date(ms).toISOString().slice(0, 7) },
};
const PROVIDERS: Provider[] = ["google", "navitime"];

const breakerKey = (provider: Provider) => `guard/${provider}/open-until`;
const countKey = (provider: Provider, period: string) => `guard/${provider}/${period}`;
const refusalKey = (provider: Provider) => `guard/${provider}/refused`;

/** A provider's last 403 or 429: when, and the start of what it said. */
export type Refusal = { status: number; at: string; said: string };
export type ProviderStatus = {
  /** Requests counted this period (Google: UTC day; NAVITIME: UTC month). */
  used: number;
  cap: number;
  period: string;
  /** Set while the breaker keeps the provider from being asked. */
  closedUntil?: string;
  refused?: Refusal;
};

/** What the guard holds in KV for each provider, for `api/status`. Three KV reads a provider; asks no provider. */
export async function guardStatus(store: GuardStore, now = Date.now()): Promise<Record<Provider, ProviderStatus>> {
  const entries = await Promise.all(PROVIDERS.map(async (provider) => {
    const { cap, period } = BUDGETS[provider];
    const [used, until, refused] = await Promise.all([
      store.get(countKey(provider, period(now))),
      store.get(breakerKey(provider)),
      store.get(refusalKey(provider)),
    ]);
    let last: Refusal | undefined;
    try {
      last = refused ? JSON.parse(refused) as Refusal : undefined;
    } catch {
      last = undefined;
    }
    const status: ProviderStatus = {
      used: Number(used) || 0,
      cap,
      period: period(now),
      ...(Number(until) > now ? { closedUntil: new Date(Number(until)).toISOString() } : {}),
      ...(last ? { refused: last } : {}),
    };
    return [provider, status] as const;
  }));
  return Object.fromEntries(entries) as Record<Provider, ProviderStatus>;
}

const perProvider = <T>(value: () => T) =>
  Object.fromEntries(PROVIDERS.map((provider) => [provider, value()])) as Record<Provider, T>;

/** What this isolate knows, across invocations. */
const memory = {
  openUntil: perProvider(() => 0),
  period: perProvider(() => ""),
  used: perProvider(() => 0),
};

/** Tests start each case with a fresh isolate. */
export function forgetGuardMemory(): void {
  memory.openUntil = perProvider(() => 0);
  memory.period = perProvider(() => "");
  memory.used = perProvider(() => 0);
}

export type Guard = {
  /** Sends a provider request, or throws ProviderRefused without sending one. */
  fetch: Fetcher;
  /** Whether a request to the provider would be sent now (no budget is spent). */
  available(provider: Provider): Promise<boolean>;
};

/** One period's count, as this invocation handles it. */
type Count = {
  period: string;
  loaded?: Promise<void> | undefined;
  ready: boolean;
  /** The highest count this invocation has got into KV. */
  written: number;
  writing?: Promise<void> | undefined;
  /** KV showed the period already spent by other isolates: send nothing more. */
  exhausted: boolean;
};

export function createGuard(
  store: GuardStore,
  options: { now?: () => number; fetch?: Fetcher } = {},
): Guard {
  const now = options.now ?? Date.now;
  // Looked up when used, so a test's stubbed global is the one called.
  const send: Fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  const breakers: Partial<Record<Provider, Promise<void>>> = {};
  const counts: Partial<Record<Provider, Count>> = {};

  /** The current period's count; a new period starts from zero, in memory and in what this invocation has written. */
  const current = (provider: Provider): Count => {
    const period = BUDGETS[provider].period(now());
    if (memory.period[provider] !== period) {
      memory.period[provider] = period;
      memory.used[provider] = 0;
    }
    let count = counts[provider];
    if (!count || count.period !== period) {
      count = { period, ready: false, written: 0, exhausted: false };
      counts[provider] = count;
    }
    return count;
  };

  /** Takes the larger of memory and KV, for this period only. */
  const merge = (provider: Provider, period: string, stored: number) => {
    if (memory.period[provider] === period) memory.used[provider] = Math.max(memory.used[provider], stored);
  };

  /** KV's breaker once per invocation, and the period's count once per period; a read failure refuses. */
  const load = async (provider: Provider): Promise<void> => {
    const breaker = (breakers[provider] ??= (async () => {
      const until = Number(await store.get(breakerKey(provider))) || 0;
      memory.openUntil[provider] = Math.max(memory.openUntil[provider], until);
    })());
    const count = current(provider);
    count.loaded ??= (async () => {
      merge(provider, count.period, Number(await store.get(countKey(provider, count.period))) || 0);
      count.ready = true;
    })();
    await Promise.all([breaker, count.loaded]);
  };

  const isOpen = (provider: Provider) => memory.openUntil[provider] > now();
  const spent = (provider: Provider) => {
    const count = current(provider);
    return count.exhausted || memory.used[provider] >= BUDGETS[provider].cap;
  };

  /**
   * Gets this invocation's count into KV, at least up to `target`, merged
   * with KV's: a read, then a write of the larger. Concurrent requests share
   * one write. If KV already held the whole budget (another isolate spent
   * it), the count is marked exhausted.
   */
  const write = async (provider: Provider, count: Count, target: number) => {
    const key = countKey(provider, count.period);
    while (count.written < target) {
      count.writing ??= (async () => {
        const stored = Number(await store.get(key)) || 0;
        if (stored >= BUDGETS[provider].cap) count.exhausted = true;
        merge(provider, count.period, stored);
        const value = Math.max(stored, memory.period[provider] === count.period ? memory.used[provider] : target);
        await store.put(key, String(value));
        count.written = Math.max(count.written, value);
      })().finally(() => {
        count.writing = undefined;
      });
      try {
        await count.writing;
      } catch {
        throw new ProviderRefused(provider, "store");
      }
    }
  };

  const trip = async (provider: Provider, response: Response) => {
    if (isOpen(provider)) return;
    const until = now() + BREAKER_OPEN_MS;
    memory.openUntil[provider] = until;
    console.warn(JSON.stringify({ message: "provider refused; not asked for an hour", provider }));
    // A copy is read, so the caller still gets the body.
    const text = await response.clone().text().catch(() => "");
    let message: unknown;
    try {
      const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      message = typeof body.error === "object" ? body.error.message : body.error ?? body.message;
    } catch {
      message = undefined;
    }
    const said = (typeof message === "string" ? message : text).replace(/\s+/g, " ").trim().slice(0, 200);
    const refusal: Refusal = { status: response.status, at: new Date(now()).toISOString(), said };
    await Promise.all([
      store.put(breakerKey(provider), String(until)).catch(() => undefined),
      store.put(refusalKey(provider), JSON.stringify(refusal)).catch(() => undefined),
    ]);
  };

  const available = async (provider: Provider) => {
    if (isOpen(provider) || spent(provider)) return false;
    try {
      await load(provider);
    } catch {
      return false;
    }
    return !isOpen(provider) && !spent(provider);
  };

  const guarded: Fetcher = async (input, init = {}) => {
    const provider = providerOf(input);
    if (!provider) throw new ProviderRefused(undefined, "host");
    let count: Count;
    do {
      if (!(await available(provider))) {
        throw new ProviderRefused(provider, isOpen(provider) ? "breaker" : spent(provider) ? "budget" : "store");
      }
      // The period can turn during the await: then the new one is loaded first.
      count = current(provider);
    } while (!count.ready);
    // Checked and counted with nothing awaited between, so concurrent
    // requests each see the others' counts.
    if (isOpen(provider)) throw new ProviderRefused(provider, "breaker");
    if (spent(provider)) throw new ProviderRefused(provider, "budget");
    memory.used[provider] += 1;
    await write(provider, count, memory.used[provider]);
    // Another request's 403 may have opened the breaker, or KV shown the
    // budget spent, while this one waited for the write.
    if (count.exhausted) throw new ProviderRefused(provider, "budget");
    if (isOpen(provider)) throw new ProviderRefused(provider, "breaker");
    const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    const response = await send(input, { ...init, signal });
    if (response.status === 403 || response.status === 429) await trip(provider, response);
    return response;
  };

  return { fetch: guarded, available };
}

/**
 * The guard's fetch, counting the requests that were actually sent (a
 * refusal sends nothing; a timeout or network failure did send). Lets a
 * caller tell "failed after asking" (remember it) from "not asked".
 */
export function counting(fetcher: Fetcher): { fetch: Fetcher; sent(): number } {
  let sent = 0;
  return {
    fetch: async (input, init) => {
      try {
        const response = await fetcher(input, init);
        sent += 1;
        return response;
      } catch (error) {
        if (!(error instanceof ProviderRefused)) sent += 1;
        throw error;
      }
    },
    sent: () => sent,
  };
}

/** Runs work past the response (the runtime's `waitUntil`), so paid-for answers are kept even if the caller goes away. */
export type Defer = (work: Promise<unknown>) => void;
