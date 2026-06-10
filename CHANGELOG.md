# Changelog

All notable changes to this project will be documented in this file.

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
