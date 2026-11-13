import type { Store, WindowResult, TokenBucketResult } from '../types.js';
import { MemoryStore } from './memory.store.js';
import { escapeGlob, isOwnKey } from '../utils/store-keys.js';

// Lua scripts for atomic Redis operations

const FIXED_WINDOW_SCRIPT = `
local key = KEYS[1]
local window_ms = tonumber(ARGV[1])

local count = redis.call('INCR', key)
if count == 1 then
  redis.call('PEXPIRE', key, window_ms)
end

local ttl = redis.call('PTTL', key)
if ttl < 0 then
  ttl = window_ms
end

return {count, ttl}
`;

const SLIDING_WINDOW_SCRIPT = `
local current_key = KEYS[1]
local previous_key = KEYS[2]
local window_ms = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local window_start = tonumber(ARGV[3])

-- Increment current window
local current_count = redis.call('INCR', current_key)
if current_count == 1 then
  redis.call('PEXPIRE', current_key, window_ms * 2)
end

-- Get previous window count
local previous_count = tonumber(redis.call('GET', previous_key) or '0')

-- Calculate progress through current window
local progress = (now - window_start) / window_ms

-- Weighted count
local weighted = math.floor(previous_count * (1 - progress) + current_count)

local ttl = redis.call('PTTL', current_key)
if ttl < 0 then
  ttl = window_ms
end

return {weighted, ttl, current_count}
`;

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(bucket[1])
local last_refill = tonumber(bucket[2])

if tokens == nil then
  -- New bucket, start full
  tokens = capacity
  last_refill = now
end

-- Refill tokens
local elapsed = (now - last_refill) / 1000
local tokens_to_add = elapsed * refill_rate
tokens = math.min(capacity, tokens + tokens_to_add)

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end

-- Save state
redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
redis.call('PEXPIRE', key, math.ceil(capacity / refill_rate) * 2000)

-- Calculate reset time (ms until next token)
local wait_ms = 0
if allowed == 0 then
  wait_ms = math.ceil(((1 - tokens) / refill_rate) * 1000)
else
  wait_ms = math.ceil((1 / refill_rate) * 1000)
end

return {allowed, math.floor(tokens), wait_ms}
`;

export interface RedisStoreOptions {
  /**
   * Fail open if Redis hasn't answered within this many milliseconds
   * (default: 500). Bounds the latency a slow or unreachable Redis can add.
   */
  timeoutMs?: number;
  /**
   * Where to count while Redis is unavailable (default: a MemoryStore).
   * Limits then apply per server instead of across all of them. Pass
   * `false` to allow every request until Redis is back.
   */
  fallback?: Store | false;
}

/**
 * Redis-backed store for distributed rate limiting.
 * Uses Lua scripts for atomic operations.
 * If Redis is unavailable, counts in memory on this server until it's back.
 */
export class RedisStore implements Store {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private connected = false;
  private timeoutMs: number;
  private fallback: Store | null;
  private degraded = false;

  /**
   * @param client - An ioredis client instance
   * @param options - See {@link RedisStoreOptions}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any, options: RedisStoreOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 500;
    this.fallback =
      options.fallback === false
        ? null
        : (options.fallback ?? new MemoryStore());
    if (typeof client === 'string') {
      // Dynamically import ioredis
      throw new Error(
        'RedisStore requires an ioredis client instance. ' +
          'Example: new RedisStore(new Redis("redis://localhost:6379"))',
      );
    }
    this.client = client;
    this.connected = true;

    this.client.on('error', () => {
      this.connected = false;
    });

    this.client.on('connect', () => {
      this.connected = true;
    });
  }

  async increment(key: string, windowMs: number): Promise<WindowResult> {
    const whileUnavailable = () =>
      this.useFallback(
        (store) => store.increment(key, windowMs),
        () => this.failOpen(windowMs),
      );
    if (!this.isAvailable()) {
      return whileUnavailable();
    }

    try {
      const result = await this.evalWithTimeout(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        windowMs,
      );
      this.markHealthy();

      const count = Number(result[0]);
      const ttl = Number(result[1]);
      const resetMs = Date.now() + ttl;

      return { count, resetMs };
    } catch {
      return whileUnavailable();
    }
  }

  async slidingIncrement(
    key: string,
    windowMs: number,
  ): Promise<WindowResult> {
    const whileUnavailable = () =>
      this.useFallback(
        (store) => store.slidingIncrement(key, windowMs),
        () => this.failOpen(windowMs),
      );
    if (!this.isAvailable()) {
      return whileUnavailable();
    }

    try {
      const now = Date.now();
      const currentWindowIndex = Math.floor(now / windowMs);
      const previousWindowIndex = currentWindowIndex - 1;
      const windowStart = currentWindowIndex * windowMs;

      const currentKey = `${key}:${currentWindowIndex}`;
      const previousKey = `${key}:${previousWindowIndex}`;

      const result = await this.evalWithTimeout(
        SLIDING_WINDOW_SCRIPT,
        2,
        currentKey,
        previousKey,
        windowMs,
        now,
        windowStart,
      );
      this.markHealthy();

      // The window resets when the current one ends. The key's TTL can't be
      // used here: it's two windows long so the next window can still read it.
      return { count: Number(result[0]), resetMs: windowStart + windowMs };
    } catch {
      return whileUnavailable();
    }
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<TokenBucketResult> {
    const whileUnavailable = () =>
      this.useFallback(
        (store) => store.consume(key, capacity, refillRate),
        () => ({ allowed: true, remaining: capacity, resetMs: Date.now() }),
      );
    if (!this.isAvailable()) {
      return whileUnavailable();
    }

    try {
      const now = Date.now();
      const result = await this.evalWithTimeout(
        TOKEN_BUCKET_SCRIPT,
        1,
        key,
        capacity,
        refillRate,
        now,
      );
      this.markHealthy();

      const allowed = Number(result[0]) === 1;
      const remaining = Number(result[1]);
      const waitMs = Number(result[2]);

      return {
        allowed,
        remaining,
        resetMs: Date.now() + waitMs,
      };
    } catch {
      return whileUnavailable();
    }
  }

  async reset(key: string): Promise<void> {
    await this.fallback?.reset(key);
    if (!this.isAvailable()) return;

    try {
      // The key itself (fixed window, token bucket) and key:<window number>
      // (sliding window). SCAN walks the keyspace in batches; KEYS would block
      // Redis until it had checked every key.
      const keys = [key];
      const pattern = `${escapeGlob(key)}:[0-9]*`;
      let cursor = '0';
      do {
        const [next, batch]: [string, string[]] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          1000,
        );
        cursor = next;
        keys.push(...batch.filter((k) => isOwnKey(k, key)));
      } while (cursor !== '0');
      await this.client.del(...keys);
    } catch {
      // Fail silently
    }
  }

  async close(): Promise<void> {
    await this.fallback?.close();
    if (this.client && typeof this.client.quit === 'function') {
      await this.client.quit();
    }
    this.connected = false;
  }

  /**
   * Count in the fallback store while Redis is unavailable, or allow the
   * request when there is none. Logs once per outage, not once per request.
   */
  private async useFallback<T>(
    countInFallback: (store: Store) => Promise<T>,
    allow: () => T,
  ): Promise<T> {
    if (!this.degraded) {
      this.degraded = true;
      console.warn(
        this.fallback
          ? '[gatekeeper] Redis unavailable — counting in memory on this server until it is back'
          : '[gatekeeper] Redis unavailable — allowing requests until it is back',
      );
    }
    return this.fallback ? countInFallback(this.fallback) : allow();
  }

  private markHealthy(): void {
    if (this.degraded) {
      this.degraded = false;
      console.warn('[gatekeeper] Redis is back — counting in Redis again');
    }
  }

  /**
   * False once the connection has been lost. While ioredis reconnects it
   * queues commands and only rejects them after maxRetriesPerRequest, about
   * 10 seconds by default, so sending one then would stall the request.
   * The first connect is not treated as down: commands queued then are sent
   * as soon as it connects, and evalWithTimeout bounds the wait if it never does.
   */
  private isAvailable(): boolean {
    if (typeof this.client.status === 'string') {
      return !['reconnecting', 'close', 'end'].includes(this.client.status);
    }
    return this.connected;
  }

  /**
   * Run a script, but give up after timeoutMs. Covers a command that was
   * already in flight when Redis went away, and a Redis that is just slow.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async evalWithTimeout(...args: unknown[]): Promise<any> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Redis did not answer in time')),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([this.client.eval(...args), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fail open — allow the request when Redis is unavailable.
   */
  private failOpen(windowMs: number): WindowResult {
    return { count: 0, resetMs: Date.now() + windowMs };
  }
}
