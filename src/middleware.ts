import type { Request, Response, NextFunction } from 'express';
import type {
  GatekeeperOptions,
  RateLimitInfo,
  ResolvedOptions,
} from './types.js';
import { MemoryStore } from './stores/memory.store.js';
import { parseDuration } from './utils/parse-duration.js';
import {
  setRateLimitHeaders,
  setRetryAfterHeader,
} from './utils/headers.js';

/**
 * Default key generator — uses the client's IP address.
 */
function defaultKeyGenerator(req: Request): string {
  return (
    req.ip ||
    req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

/**
 * Resolve user options with sensible defaults.
 */
function resolveOptions(options: GatekeeperOptions = {}): ResolvedOptions {
  return {
    limit: options.limit ?? 100,
    windowMs:
      options.window !== undefined ? parseDuration(options.window) : 60_000,
    algorithm: options.algorithm ?? 'sliding-window',
    store: options.store ?? new MemoryStore(),
    keyGenerator: options.keyGenerator ?? defaultKeyGenerator,
    message: options.message ?? 'Too Many Requests',
    prefix: options.prefix ?? 'gk:',
    skip: options.skip ?? (() => false),
    handler: options.handler ?? null,
    headers: options.headers ?? true,
    statusCode: options.statusCode ?? 429,
    capacity: options.capacity ?? 100,
    refillRate: options.refillRate ?? 10,
  };
}

/**
 * Creates an Express rate limiting middleware.
 *
 * @example
 * // Basic usage — 100 requests per minute per IP
 * app.use(gatekeeper());
 *
 * @example
 * // Custom limits
 * app.use(gatekeeper({ limit: 10, window: '15m' }));
 *
 * @example
 * // Token bucket
 * app.use(gatekeeper({ algorithm: 'token-bucket', capacity: 50, refillRate: 5 }));
 *
 * @example
 * // Per-user rate limiting
 * app.use(gatekeeper({
 *   keyGenerator: (req) => req.headers['x-api-key'] || req.ip,
 * }));
 */
export function gatekeeper(
  options?: GatekeeperOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const opts = resolveOptions(options);

  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // Check if this request should skip rate limiting
    if (opts.skip(req)) {
      next();
      return;
    }

    const key = `${opts.prefix}${opts.keyGenerator(req)}`;

    try {
      let info: RateLimitInfo;

      if (opts.algorithm === 'token-bucket') {
        // Token Bucket
        const result = await opts.store.consume(
          key,
          opts.capacity,
          opts.refillRate,
        );

        info = {
          limit: opts.capacity,
          remaining: result.remaining,
          reset: Math.ceil(result.resetMs / 1000),
          retryAfter: result.allowed
            ? 0
            : Math.ceil((result.resetMs - Date.now()) / 1000),
        };

        if (opts.headers) {
          setRateLimitHeaders(res, info);
        }

        if (!result.allowed) {
          if (opts.headers) {
            setRetryAfterHeader(res, info.retryAfter);
          }

          if (opts.handler) {
            opts.handler(req, res, next, info);
            return;
          }

          res.status(opts.statusCode).json({
            error: 'Too Many Requests',
            message: opts.message,
            retryAfter: info.retryAfter,
          });
          return;
        }
      } else {
        // Fixed Window or Sliding Window
        const result =
          opts.algorithm === 'sliding-window'
            ? await opts.store.slidingIncrement(key, opts.windowMs)
            : await opts.store.increment(key, opts.windowMs);

        const remaining = Math.max(0, opts.limit - result.count);
        const resetSec = Math.ceil(result.resetMs / 1000);
        const retryAfter = Math.max(
          0,
          Math.ceil((result.resetMs - Date.now()) / 1000),
        );

        info = {
          limit: opts.limit,
          remaining,
          reset: resetSec,
          retryAfter,
        };

        if (opts.headers) {
          setRateLimitHeaders(res, info);
        }

        if (result.count > opts.limit) {
          if (opts.headers) {
            setRetryAfterHeader(res, retryAfter);
          }

          if (opts.handler) {
            opts.handler(req, res, next, info);
            return;
          }

          res.status(opts.statusCode).json({
            error: 'Too Many Requests',
            message: opts.message,
            retryAfter,
          });
          return;
        }
      }

      next();
    } catch {
      // Fail open — if something goes wrong, allow the request
      next();
    }
  };
}
