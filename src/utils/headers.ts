import type { Response } from 'express';
import type { RateLimitInfo } from '../types.js';

/**
 * Set standard rate limit headers on the response.
 *
 * Headers:
 * - X-RateLimit-Limit: max requests allowed
 * - X-RateLimit-Remaining: requests left
 * - X-RateLimit-Reset: unix timestamp when window resets
 */
export function setRateLimitHeaders(
  res: Response,
  info: RateLimitInfo,
): void {
  res.setHeader('X-RateLimit-Limit', info.limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, info.remaining));
  res.setHeader('X-RateLimit-Reset', info.reset);
}

/**
 * Set the Retry-After header (used on 429 responses).
 */
export function setRetryAfterHeader(
  res: Response,
  retryAfter: number,
): void {
  res.setHeader('Retry-After', Math.ceil(retryAfter));
}
