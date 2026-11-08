import type { Store, WindowResult, TokenBucketResult } from '../types.js';

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
}

/**
 * Redis-backed store for distributed rate limiting.
 * Uses Lua scripts for atomic operations.
 * Fails open — if Redis errors, requests are allowed.
 */
export class RedisStore implements Store {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private connected = false;
  private timeoutMs: number;

  /**
   * @param client - An ioredis client instance
   * @param options - See {@link RedisStoreOptions}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any, options: RedisStoreOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 500;
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
    if (!this.isAvailable()) {
      return this.failOpen(windowMs);
    }

    try {
      const result = await this.evalWithTimeout(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        windowMs,
      );

      const count = Number(result[0]);
      const ttl = Number(result[1]);
      const resetMs = Date.now() + ttl;

      return { count, resetMs };
    } catch {
      return this.failOpen(windowMs);
    }
  }

  async slidingIncrement(
    key: string,
    windowMs: number,
  ): Promise<WindowResult> {
    if (!this.isAvailable()) {
      return this.failOpen(windowMs);
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

      // The window resets when the current one ends. The key's TTL can't be
      // used here: it's two windows long so the next window can still read it.
      return { count: Number(result[0]), resetMs: windowStart + windowMs };
    } catch {
      return this.failOpen(windowMs);
    }
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<TokenBucketResult> {
    if (!this.isAvailable()) {
      return { allowed: true, remaining: capacity, resetMs: Date.now() };
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

      const allowed = Number(result[0]) === 1;
      const remaining = Number(result[1]);
      const waitMs = Number(result[2]);

      return {
        allowed,
        remaining,
        resetMs: Date.now() + waitMs,
      };
    } catch {
      return { allowed: true, remaining: capacity, resetMs: Date.now() };
    }
  }

  async reset(key: string): Promise<void> {
    if (!this.isAvailable()) return;

    try {
      // Find and delete all keys matching the pattern
      const keys = await this.client.keys(`${key}*`);
      if (keys.length > 0) {
        await this.client.del(...keys);
      }
    } catch {
      // Fail silently
    }
  }

  async close(): Promise<void> {
    if (this.client && typeof this.client.quit === 'function') {
      await this.client.quit();
    }
    this.connected = false;
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
    console.warn(
      '[gatekeeper] Redis unavailable — failing open (allowing request)',
    );
    return { count: 0, resetMs: Date.now() + windowMs };
  }
}
