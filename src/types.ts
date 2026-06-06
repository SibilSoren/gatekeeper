import type { Request, Response, NextFunction } from 'express';

// ─── Public Types ───────────────────────────────────────

export type Algorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';

export interface GatekeeperOptions {
  /** Max requests per window (default: 100). Not used with token-bucket. */
  limit?: number;

  /** Time window — string like "1m", "15m", "1h" or milliseconds (default: "1m"). Not used with token-bucket. */
  window?: string | number;

  /** Rate limiting algorithm (default: "sliding-window") */
  algorithm?: Algorithm;

  /** Storage backend (default: MemoryStore) */
  store?: Store;

  /** Generate the rate limit key from the request (default: req.ip) */
  keyGenerator?: (req: Request) => string;

  /** Custom response message when rate limited (default: "Too Many Requests") */
  message?: string;

  /** Key prefix for storage (default: "gk:") */
  prefix?: string;

  /** Skip rate limiting for certain requests */
  skip?: (req: Request) => boolean;

  /** Custom handler when rate limit is exceeded */
  handler?: (
    req: Request,
    res: Response,
    next: NextFunction,
    info: RateLimitInfo,
  ) => void;

  /** Include standard X-RateLimit-* headers in responses (default: true) */
  headers?: boolean;

  /** HTTP status code when rate limited (default: 429) */
  statusCode?: number;

  // ─── Token Bucket specific ───────────────────────────

  /** Bucket capacity — max tokens (token-bucket only, default: 100) */
  capacity?: number;

  /** Tokens added per second (token-bucket only, default: 10) */
  refillRate?: number;
}

export interface RateLimitInfo {
  /** Max requests allowed in the window */
  limit: number;
  /** Remaining requests in the current window */
  remaining: number;
  /** Unix timestamp (seconds) when the window resets */
  reset: number;
  /** Seconds until the client should retry */
  retryAfter: number;
}

// ─── Store Interface ────────────────────────────────────

export interface WindowResult {
  /** Current request count in the window */
  count: number;
  /** Unix timestamp (ms) when the window resets */
  resetMs: number;
}

export interface TokenBucketResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Remaining tokens */
  remaining: number;
  /** Unix timestamp (ms) when a token will be available */
  resetMs: number;
}

export interface Store {
  /**
   * Increment the counter for a window-based algorithm.
   * Returns current count and reset time.
   */
  increment(key: string, windowMs: number): Promise<WindowResult>;

  /**
   * Sliding window: get weighted count across two windows.
   */
  slidingIncrement(key: string, windowMs: number): Promise<WindowResult>;

  /**
   * Consume a token from the bucket.
   */
  consume(
    key: string,
    capacity: number,
    refillRate: number,
  ): Promise<TokenBucketResult>;

  /** Reset a specific key */
  reset(key: string): Promise<void>;

  /** Clean up resources (intervals, connections) */
  close(): Promise<void>;
}

// ─── Resolved Options (with defaults applied) ───────────

export interface ResolvedOptions {
  limit: number;
  windowMs: number;
  algorithm: Algorithm;
  store: Store;
  keyGenerator: (req: Request) => string;
  message: string;
  prefix: string;
  skip: (req: Request) => boolean;
  handler:
    | ((
        req: Request,
        res: Response,
        next: NextFunction,
        info: RateLimitInfo,
      ) => void)
    | null;
  headers: boolean;
  statusCode: number;
  capacity: number;
  refillRate: number;
}
