import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { gatekeeper } from '../src/middleware.js';
import { MemoryStore } from '../src/stores/memory.store.js';

function createApp(options = {}) {
  const app = express();
  app.use(gatekeeper(options));
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('gatekeeper middleware', () => {
  describe('Fixed Window', () => {
    it('should allow requests under the limit', async () => {
      const app = createApp({
        algorithm: 'fixed-window',
        limit: 5,
        window: '1m',
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('should block requests over the limit', async () => {
      const store = new MemoryStore();
      const app = createApp({
        algorithm: 'fixed-window',
        limit: 3,
        window: '1m',
        store,
      });

      // Send 3 requests (all should pass)
      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/test');
        expect(res.status).toBe(200);
      }

      // 4th request should be blocked
      const res = await request(app).get('/test');
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('Too Many Requests');

      await store.close();
    });

    it('should include rate limit headers', async () => {
      const app = createApp({
        algorithm: 'fixed-window',
        limit: 10,
        window: '1m',
      });

      const res = await request(app).get('/test');
      expect(res.headers['x-ratelimit-limit']).toBe('10');
      expect(res.headers['x-ratelimit-remaining']).toBeDefined();
      expect(res.headers['x-ratelimit-reset']).toBeDefined();
    });

    it('should include Retry-After header on 429', async () => {
      const store = new MemoryStore();
      const app = createApp({
        algorithm: 'fixed-window',
        limit: 1,
        window: '1m',
        store,
      });

      await request(app).get('/test');
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();

      await store.close();
    });
  });

  describe('Sliding Window', () => {
    it('should allow requests under the limit', async () => {
      const app = createApp({
        algorithm: 'sliding-window',
        limit: 5,
        window: '1m',
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    });

    it('should block requests over the limit', async () => {
      const store = new MemoryStore();
      const app = createApp({
        algorithm: 'sliding-window',
        limit: 3,
        window: '1m',
        store,
      });

      for (let i = 0; i < 3; i++) {
        const res = await request(app).get('/test');
        expect(res.status).toBe(200);
      }

      const res = await request(app).get('/test');
      expect(res.status).toBe(429);

      await store.close();
    });
  });

  describe('Token Bucket', () => {
    it('should allow requests when tokens are available', async () => {
      const app = createApp({
        algorithm: 'token-bucket',
        capacity: 10,
        refillRate: 5,
      });

      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    });

    it('should block requests when tokens are exhausted', async () => {
      const store = new MemoryStore();
      const app = createApp({
        algorithm: 'token-bucket',
        capacity: 2,
        refillRate: 0.1, // Very slow refill
        store,
      });

      // Consume all tokens
      await request(app).get('/test');
      await request(app).get('/test');

      // Should be blocked
      const res = await request(app).get('/test');
      expect(res.status).toBe(429);

      await store.close();
    });
  });

  describe('Options', () => {
    it('should use default algorithm (sliding-window)', async () => {
      const app = createApp({ limit: 5 });
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    });

    it('should support custom key generator', async () => {
      const store = new MemoryStore();
      const app = express();

      app.use(
        gatekeeper({
          limit: 1,
          window: '1m',
          store,
          keyGenerator: (req) => req.headers['x-api-key']?.toString() || 'anon',
        }),
      );
      app.get('/test', (_req, res) => res.json({ ok: true }));

      // Different keys should have independent limits
      const res1 = await request(app)
        .get('/test')
        .set('X-API-Key', 'key-1');
      expect(res1.status).toBe(200);

      const res2 = await request(app)
        .get('/test')
        .set('X-API-Key', 'key-2');
      expect(res2.status).toBe(200);

      // Same key, over limit
      const res3 = await request(app)
        .get('/test')
        .set('X-API-Key', 'key-1');
      expect(res3.status).toBe(429);

      await store.close();
    });

    it('should support skip function', async () => {
      const store = new MemoryStore();
      const app = express();

      app.use(
        gatekeeper({
          limit: 1,
          window: '1m',
          store,
          skip: (req) => req.headers['x-skip'] === 'true',
        }),
      );
      app.get('/test', (_req, res) => res.json({ ok: true }));

      // First normal request uses up the limit
      await request(app).get('/test');

      // Skipped request should always pass
      const res = await request(app)
        .get('/test')
        .set('X-Skip', 'true');
      expect(res.status).toBe(200);

      await store.close();
    });

    it('should support custom message', async () => {
      const store = new MemoryStore();
      const app = createApp({
        limit: 1,
        window: '1m',
        store,
        message: 'Slow down there, partner!',
      });

      await request(app).get('/test');
      const res = await request(app).get('/test');

      expect(res.status).toBe(429);
      expect(res.body.message).toBe('Slow down there, partner!');

      await store.close();
    });

    it('should support custom handler', async () => {
      const store = new MemoryStore();
      const app = express();

      app.use(
        gatekeeper({
          limit: 1,
          window: '1m',
          store,
          handler: (_req, res, _next, info) => {
            res.status(503).json({ custom: true, remaining: info.remaining });
          },
        }),
      );
      app.get('/test', (_req, res) => res.json({ ok: true }));

      await request(app).get('/test');
      const res = await request(app).get('/test');

      expect(res.status).toBe(503);
      expect(res.body.custom).toBe(true);

      await store.close();
    });

    it('should support disabling headers', async () => {
      const app = createApp({ limit: 10, headers: false });
      const res = await request(app).get('/test');

      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
    });
  });
});

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(60_000);
  });

  afterEach(async () => {
    await store.close();
  });

  it('should increment fixed window counter', async () => {
    const r1 = await store.increment('test', 60_000);
    expect(r1.count).toBe(1);

    const r2 = await store.increment('test', 60_000);
    expect(r2.count).toBe(2);
  });

  it('should increment sliding window counter', async () => {
    const r1 = await store.slidingIncrement('test', 60_000);
    expect(r1.count).toBeGreaterThanOrEqual(1);
  });

  it('should consume tokens', async () => {
    const r1 = await store.consume('test', 5, 1);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(4);
  });

  it('should block when tokens exhausted', async () => {
    for (let i = 0; i < 3; i++) {
      await store.consume('test', 3, 0.001);
    }

    const result = await store.consume('test', 3, 0.001);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should reset keys', async () => {
    await store.increment('test', 60_000);
    await store.increment('test', 60_000);
    await store.reset('test');

    const result = await store.increment('test', 60_000);
    expect(result.count).toBe(1);
  });
});
