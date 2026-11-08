import { describe, it, expect, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Redis } from 'ioredis';
import {
  connect,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { gatekeeper } from '../src/middleware.js';
import { RedisStore } from '../src/stores/redis.store.js';
import type { GatekeeperOptions } from '../src/types.js';

/**
 * RedisStore against a real Redis (or Valkey). These run when REDIS_URL is set:
 *
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 *
 * CI starts a Redis service for them, so the Lua scripts run on every push.
 */
const REDIS_URL = process.env.REDIS_URL;

let run = 0;
/** A key prefix no other test uses, so counters never collide between tests. */
const freshPrefix = () => `gk-test:${process.pid}:${Date.now()}:${run++}:`;

function createApp(store: RedisStore, options: GatekeeperOptions) {
  const app = express();
  app.use(gatekeeper({ ...options, store }));
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const algorithms = [
  { algorithm: 'fixed-window', limit: 3, window: '1m' },
  { algorithm: 'sliding-window', limit: 3, window: '1m' },
  // A refill this slow adds nothing while the test runs.
  { algorithm: 'token-bucket', capacity: 3, refillRate: 0.001 },
] as const;

describe.skipIf(!REDIS_URL)('RedisStore with a real Redis', () => {
  const stores: RedisStore[] = [];

  /** Each store gets its own connection, the way two app servers would. */
  function newStore(): RedisStore {
    const store = new RedisStore(new Redis(REDIS_URL!));
    stores.push(store);
    return store;
  }

  afterAll(async () => {
    await Promise.all(stores.map((s) => s.close()));
  });

  it.each(algorithms)(
    '$algorithm: blocks the first request over the limit',
    async (opts) => {
      const app = createApp(newStore(), { ...opts, prefix: freshPrefix() });

      for (let i = 0; i < 3; i++) {
        expect((await request(app).get('/test')).status).toBe(200);
      }
      const blocked = await request(app).get('/test');
      expect(blocked.status).toBe(429);
      expect(blocked.headers['x-ratelimit-remaining']).toBe('0');
    },
  );

  it.each(algorithms)(
    '$algorithm: lets exactly the limit through when two servers get 100 requests at once',
    async (opts) => {
      const limits =
        opts.algorithm === 'token-bucket' ? { capacity: 10 } : { limit: 10 };
      const shared = { ...opts, ...limits, prefix: freshPrefix() };
      const serverA = createApp(newStore(), shared);
      const serverB = createApp(newStore(), shared);

      const responses = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          request(i % 2 === 0 ? serverA : serverB).get('/test'),
        ),
      );

      const allowed = responses.filter((r) => r.status === 200).length;
      const blocked = responses.filter((r) => r.status === 429).length;
      expect({ allowed, blocked }).toEqual({ allowed: 10, blocked: 90 });
    },
    30_000,
  );

  it.each(['fixed-window', 'sliding-window'] as const)(
    '%s: Retry-After is never longer than the window',
    async (algorithm) => {
      const app = createApp(newStore(), {
        algorithm,
        limit: 1,
        window: '1m',
        prefix: freshPrefix(),
      });

      await request(app).get('/test');
      const blocked = await request(app).get('/test');

      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
      // X-RateLimit-Reset is a unix time rounded up to the second, hence the +1.
      expect(
        Number(blocked.headers['x-ratelimit-reset']) - Date.now() / 1000,
      ).toBeLessThanOrEqual(61);
    },
  );

  it('fails open without making requests wait when Redis goes away mid-run', async () => {
    const proxy = await startProxy(new URL(REDIS_URL!));
    const client = new Redis(proxy.url);
    const app = createApp(new RedisStore(client), {
      algorithm: 'fixed-window',
      limit: 5,
      window: '1m',
      prefix: freshPrefix(),
    });

    try {
      expect((await request(app).get('/test')).status).toBe(200);
      await proxy.kill();

      const started = Date.now();
      const res = await request(app).get('/test');
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      client.disconnect();
    }
  }, 30_000);
});

/**
 * A TCP proxy in front of Redis that a test can cut, to simulate Redis dying
 * while the app is running without touching the real server.
 */
async function startProxy(
  target: URL,
): Promise<{ url: string; kill: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((inbound) => {
    const upstream = connect(Number(target.port || 6379), target.hostname);
    sockets.add(inbound);
    sockets.add(upstream);
    inbound.pipe(upstream).pipe(inbound);
    const drop = () => {
      inbound.destroy();
      upstream.destroy();
    };
    inbound.on('error', drop);
    upstream.on('error', drop);
    inbound.on('close', drop);
    upstream.on('close', drop);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `redis://127.0.0.1:${port}`,
    kill: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('RedisStore when Redis is unreachable', () => {
  it('gives up on a Redis that accepts the connection but never answers', async () => {
    // Accepts TCP connections and never replies, like an overloaded server.
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) =>
      silent.listen(0, '127.0.0.1', resolve),
    );
    const { port } = silent.address() as AddressInfo;

    const client = new Redis(`redis://127.0.0.1:${port}`);
    const app = createApp(new RedisStore(client, { timeoutMs: 300 }), {
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
      prefix: freshPrefix(),
    });

    try {
      const started = Date.now();
      const res = await request(app).get('/test');
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      client.disconnect();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  }, 30_000);

  it('fails open without making the request wait', async () => {
    // Nothing listens on port 1, so every connection attempt is refused.
    const client = new Redis('redis://127.0.0.1:1');
    const app = createApp(new RedisStore(client), {
      algorithm: 'fixed-window',
      limit: 1,
      window: '1m',
      prefix: freshPrefix(),
    });

    try {
      const started = Date.now();
      const res = await request(app).get('/test');
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      client.disconnect();
    }
  }, 30_000);
});
