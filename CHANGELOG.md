# Changelog

All notable changes to this project will be documented in this file.

## [2.0.1] - 2026-11-13

### Fixed

- `reset(key)` also deleted the counters of every key that started with `key`, such as `gk:1.2.3.45` when resetting `gk:1.2.3.4`. Both stores now delete only that key's own counters.
- RedisStore: `reset()` uses `SCAN` instead of `KEYS`, which blocked Redis while it checked every key.
- RedisStore: the token bucket uses Redis's clock instead of the app server's. When servers' clocks disagreed, a fast one handed out tokens early and a slow one took them away. This needs Redis 5 or later, or Valkey.

### Added

- `@sibilsoren/gatekeeper/package.json` can be imported, for tools that read the installed version.

## [2.0.0] - 2026-11-09

### Changed

- **Breaking:** while Redis is unavailable, RedisStore now counts in memory on each server instead of allowing every request. Limits still apply during an outage, per server rather than across all of them. Pass `fallback: false` to keep the old behavior.
- RedisStore logs once when Redis becomes unavailable and once when it's back, instead of a warning on every request.

### Added

- `fallback` option for `RedisStore`: the store to count in while Redis is unavailable (default: a `MemoryStore`), or `false` to allow every request.

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
