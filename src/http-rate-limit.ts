/**
 * Tiny in-memory fixed-window rate limiter (per process, zero dependencies).
 * Applied to the unauthenticated token endpoints (/auth/device/exchange,
 * /auth/device/refresh) — addresses the open review finding that those
 * routes could be brute-forced. Good enough for a single-instance API;
 * swap for a shared store if this ever scales out.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True when the request is allowed, false when the key is over the limit. */
  allow(key: string): boolean {
    const now = Date.now();

    // Opportunistic pruning so the map cannot grow unbounded.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (b.resetAt <= now) this.buckets.delete(k);
      }
    }

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count++;
    return bucket.count <= this.limit;
  }
}
