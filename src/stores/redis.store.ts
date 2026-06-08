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

/**
 * Redis-backed store for distributed rate limiting.
 * Uses Lua scripts for atomic operations.
 * Fails open — if Redis errors, requests are allowed.
 */
export class RedisStore implements Store {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private connected = false;

  /**
   * @param client - An ioredis client instance or connection string
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(client: any) {
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
    if (!this.connected) {
      return this.failOpen(windowMs);
    }

    try {
      const result = await this.client.eval(
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
    if (!this.connected) {
      return this.failOpen(windowMs);
    }

    try {
      const now = Date.now();
      const currentWindowIndex = Math.floor(now / windowMs);
      const previousWindowIndex = currentWindowIndex - 1;
      const windowStart = currentWindowIndex * windowMs;

      const currentKey = `${key}:${currentWindowIndex}`;
      const previousKey = `${key}:${previousWindowIndex}`;

      const result = await this.client.eval(
        SLIDING_WINDOW_SCRIPT,
        2,
        currentKey,
        previousKey,
        windowMs,
        now,
        windowStart,
      );

      const count = Number(result[0]);
      const ttl = Number(result[1]);
      const resetMs = Date.now() + ttl;

      return { count, resetMs };
    } catch {
      return this.failOpen(windowMs);
    }
  }

  async consume(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<TokenBucketResult> {
    if (!this.connected) {
      return { allowed: true, remaining: capacity, resetMs: Date.now() };
    }

    try {
      const now = Date.now();
      const result = await this.client.eval(
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
    if (!this.connected) return;

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
   * Fail open — allow the request when Redis is unavailable.
   */
  private failOpen(windowMs: number): WindowResult {
    console.warn(
      '[gatekeeper] Redis unavailable — failing open (allowing request)',
    );
    return { count: 0, resetMs: Date.now() + windowMs };
  }
}
