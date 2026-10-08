/**
 * Sliding-window request limiter, keyed by client.
 *
 * State lives in this instance's memory, which on Vercel means per function
 * instance rather than global. That is a deliberate trade: Fluid Compute reuses
 * instances, so a single client hammering an endpoint mostly lands on the same
 * one and is limited, while a distributed attacker could spread across
 * instances. Stopping that needs shared state or the platform firewall; this
 * stops the cheap case -- one script in a loop -- at no infrastructure cost.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest counted request leaves the window. 0 when allowed. */
  retryAfterSeconds: number;
}

/** Past this many tracked clients, lapsed entries are pruned on the next hit. */
const PRUNE_THRESHOLD = 10_000;

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  check(key: string): RateLimitResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((time) => time > cutoff);

    if (recent.length >= this.limit) {
      // Refusals are not counted, so a client that keeps retrying is let back
      // in as soon as its earlier requests age out, not locked out forever.
      this.hits.set(key, recent);
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > PRUNE_THRESHOLD) this.prune(cutoff);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  reset(): void {
    this.hits.clear();
  }

  private prune(cutoff: number): void {
    for (const [key, times] of this.hits) {
      if (times[times.length - 1] <= cutoff) this.hits.delete(key);
    }
  }
}

const registry = new Set<RateLimiter>();

/** Creates a limiter that `resetRateLimiters` can reach, for route modules. */
export function createRateLimiter(limit: number, windowMs: number): RateLimiter {
  const limiter = new RateLimiter(limit, windowMs);
  registry.add(limiter);
  return limiter;
}

/** Test seam: route limiters are module-level, so suites must clear them. */
export function resetRateLimiters(): void {
  for (const limiter of registry) limiter.reset();
}
