import type { Store, WindowResult, TokenBucketResult } from '../types.js';

interface WindowEntry {
  count: number;
  resetMs: number;
}

interface BucketEntry {
  tokens: number;
  lastRefillMs: number;
}

/**
 * In-memory store using Maps with automatic cleanup.
 * Suitable for single-server deployments and development.
 */
export class MemoryStore implements Store {
  private windows = new Map<string, WindowEntry>();
  private buckets = new Map<string, BucketEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(cleanupIntervalMs = 60_000) {
    // Periodically clean up expired entries to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, cleanupIntervalMs);

    // Don't prevent process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Fixed Window: Increment counter for the current window.
   */
  async increment(key: string, windowMs: number): Promise<WindowResult> {
    const now = Date.now();
    const windowKey = `${key}:${Math.floor(now / windowMs)}`;
    const resetMs = (Math.floor(now / windowMs) + 1) * windowMs;

    const entry = this.windows.get(windowKey);

    if (entry) {
      entry.count += 1;
      return { count: entry.count, resetMs: entry.resetMs };
    }

    this.windows.set(windowKey, { count: 1, resetMs });
    return { count: 1, resetMs };
  }

  /**
   * Sliding Window Counter: Weighted count from current + previous window.
   */
  async slidingIncrement(key: string, windowMs: number): Promise<WindowResult> {
    const now = Date.now();
    const currentWindowIndex = Math.floor(now / windowMs);
    const previousWindowIndex = currentWindowIndex - 1;

    const currentKey = `${key}:${currentWindowIndex}`;
    const previousKey = `${key}:${previousWindowIndex}`;

    // Increment current window
    const currentEntry = this.windows.get(currentKey);
    if (currentEntry) {
      currentEntry.count += 1;
    } else {
      this.windows.set(currentKey, {
        count: 1,
        resetMs: (currentWindowIndex + 1) * windowMs,
      });
    }

    const currentCount = currentEntry ? currentEntry.count : 1;
    const previousCount = this.windows.get(previousKey)?.count ?? 0;

    // Calculate how far we are into the current window (0.0 → 1.0)
    const windowStart = currentWindowIndex * windowMs;
    const progress = (now - windowStart) / windowMs;

    // Weighted count: previous × (1 - progress) + current
    const weightedCount = Math.floor(
      previousCount * (1 - progress) + currentCount,
    );

    const resetMs = (currentWindowIndex + 1) * windowMs;

    return { count: weightedCount, resetMs };
  }

  /**
   * Token Bucket: Consume a token, refilling based on elapsed time.
   */
  async consume(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<TokenBucketResult> {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // New bucket starts full
      bucket = { tokens: capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefillMs;
    const tokensToAdd = (elapsedMs / 1000) * refillRate;
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      // Time until next token
      const resetMs = now + (1 / refillRate) * 1000;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetMs,
      };
    }

    // Not enough tokens — calculate when one will be available
    const waitMs = ((1 - bucket.tokens) / refillRate) * 1000;
    return {
      allowed: false,
      remaining: 0,
      resetMs: now + waitMs,
    };
  }

  async reset(key: string): Promise<void> {
    // Remove all entries matching this key prefix
    for (const k of this.windows.keys()) {
      if (k.startsWith(key)) {
        this.windows.delete(k);
      }
    }
    this.buckets.delete(key);
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.windows.clear();
    this.buckets.clear();
  }

  /**
   * Remove expired window entries.
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (entry.resetMs < now) {
        this.windows.delete(key);
      }
    }
  }
}
