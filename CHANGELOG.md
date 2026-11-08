# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-11-08

### Fixed

- RedisStore: with the sliding window, `Retry-After` and `X-RateLimit-Reset` pointed up to two windows ahead. They now point at the end of the current window, the same as MemoryStore.
- RedisStore: requests no longer hang when Redis is down or stops answering. Checks are skipped while the connection is lost, and each check fails open after `timeoutMs`. Before this, a request could wait about 10 seconds while ioredis reconnected, or never finish if Redis accepted connections but didn't reply.

### Added

- `timeoutMs` option for `RedisStore` (default 500).
- Tests against a real Redis-compatible server (Valkey in CI), including two servers sharing one limit under 100 concurrent requests.

## [1.0.0] - 2026-06-10

### Added

- Initial release
- Fixed Window algorithm
- Sliding Window Counter algorithm (default)
- Token Bucket algorithm
- In-memory store (MemoryStore)
- Redis store (RedisStore) with Lua scripts for atomicity
- Fail-open behavior when Redis is unavailable
- Standard `X-RateLimit-*` and `Retry-After` headers
- Custom key generator, skip function, and error handler
- Full TypeScript types
- Dual ESM + CJS builds
