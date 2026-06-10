<div align="center">
  <img src="docs/assets/logo.png" alt="Gatekeeper Logo" width="120" />
</div>

# @sibilsoren/gatekeeper

[![npm version](https://img.shields.io/npm/v/@sibilsoren/gatekeeper.svg)](https://www.npmjs.com/package/@sibilsoren/gatekeeper)
[![CI](https://github.com/SibilSoren/gatekeeper/actions/workflows/ci.yml/badge.svg)](https://github.com/SibilSoren/gatekeeper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Production-grade, Redis-backed API rate limiting middleware for Express.

- ⚡ **3 algorithms** — Fixed Window, Sliding Window Counter, Token Bucket
- 🔴 **Redis-backed** — Distributed rate limiting across multiple servers
- 💾 **In-memory fallback** — Zero-config for development and single-server
- 🛡️ **Fail-open** — If Redis goes down, requests are allowed (not blocked)
- 📊 **Standard headers** — `X-RateLimit-*` and `Retry-After` out of the box
- 🎯 **Flexible keys** — Rate limit by IP, API key, user ID, or custom function
- 🪶 **Tiny** — Zero runtime dependencies (ioredis is an optional peer dep)

## Install

```bash
npm install @sibilsoren/gatekeeper
```

For Redis support (optional):

```bash
npm install @sibilsoren/gatekeeper ioredis
```

## Quick Start

```typescript
import express from 'express';
import { gatekeeper } from '@sibilsoren/gatekeeper';

const app = express();

// 100 requests per minute per IP (sliding window)
app.use(gatekeeper());

// Custom limits per route
app.post('/auth/login', gatekeeper({
  limit: 5,
  window: '15m',
  message: 'Too many login attempts. Try again later.',
}));

app.listen(3000);
```

## Algorithms

### Sliding Window Counter (default)

The most accurate algorithm. Prevents boundary burst attacks by weighting the previous window's count.

```typescript
app.use(gatekeeper({
  algorithm: 'sliding-window',  // default
  limit: 100,
  window: '1m',
}));
```

### Fixed Window

Simplest algorithm. Resets the counter at the start of each window.

```typescript
app.use(gatekeeper({
  algorithm: 'fixed-window',
  limit: 100,
  window: '1m',
}));
```

### Token Bucket

Best for APIs with burst traffic. Tokens refill at a steady rate.

```typescript
app.use(gatekeeper({
  algorithm: 'token-bucket',
  capacity: 50,     // Max burst
  refillRate: 10,   // 10 tokens per second
}));
```

## Redis Store (Distributed)

For multi-server deployments, use the Redis store:

```typescript
import { gatekeeper, RedisStore } from '@sibilsoren/gatekeeper';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379');

app.use(gatekeeper({
  store: new RedisStore(redis),
  limit: 100,
  window: '1m',
}));
```

If Redis goes down, Gatekeeper **fails open** — requests are allowed through. Your API stays up even if Redis doesn't.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `limit` | `number` | `100` | Max requests per window |
| `window` | `string \| number` | `"1m"` | Window size (`"30s"`, `"5m"`, `"1h"`, or ms) |
| `algorithm` | `string` | `"sliding-window"` | `"fixed-window"`, `"sliding-window"`, `"token-bucket"` |
| `store` | `Store` | `MemoryStore` | Storage backend |
| `keyGenerator` | `(req) => string` | `req.ip` | Function to generate rate limit key |
| `message` | `string` | `"Too Many Requests"` | Error message on 429 |
| `prefix` | `string` | `"gk:"` | Key prefix in storage |
| `skip` | `(req) => boolean` | `() => false` | Skip rate limiting for certain requests |
| `handler` | `function` | `null` | Custom 429 response handler |
| `headers` | `boolean` | `true` | Include `X-RateLimit-*` headers |
| `statusCode` | `number` | `429` | HTTP status when limited |
| `capacity` | `number` | `100` | Token bucket capacity |
| `refillRate` | `number` | `10` | Tokens per second (token bucket) |

## Examples

### Rate limit by API key

```typescript
app.use(gatekeeper({
  keyGenerator: (req) => req.headers['x-api-key']?.toString() || req.ip,
}));
```

### Skip health checks

```typescript
app.use(gatekeeper({
  skip: (req) => req.path === '/health',
}));
```

### Custom error response

```typescript
app.use(gatekeeper({
  handler: (req, res, next, info) => {
    res.status(429).json({
      error: 'Rate Limited',
      limit: info.limit,
      remaining: info.remaining,
      retryAfter: info.retryAfter,
    });
  },
}));
```

### Different limits per route

```typescript
// Strict for auth
app.use('/auth', gatekeeper({ limit: 5, window: '15m' }));

// Generous for read-only
app.use('/api', gatekeeper({ limit: 1000, window: '1m' }));
```

## Response Headers

Every response includes rate limit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1718042520
```

When rate limited (429):

```
Retry-After: 30
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features and improvements.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## License

[MIT](LICENSE) © [SibilSoren](https://github.com/SibilSoren)
