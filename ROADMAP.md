# Roadmap

Future improvements and feature ideas for Gatekeeper.

## v2 — Framework Agnostic

- [ ] **Fastify adapter** — `@sibilsoren/gatekeeper-fastify`
- [ ] **Hono adapter** — `@sibilsoren/gatekeeper-hono`
- [ ] **Koa adapter** — `@sibilsoren/gatekeeper-koa`
- [ ] **Generic core** — Framework-independent algorithm engine that any adapter can use

## v3 — Advanced Rate Limiting Patterns

- [ ] **Dynamic limits** — Change limits at runtime without restart
- [ ] **Tiered rate limits** — Different limits per user tier (free: 100/min, pro: 1000/min)
- [ ] **Cost-based limiting** — Different endpoints cost different amounts of "points"
- [ ] **Rate limit groups** — Share a limit across multiple routes
- [ ] **Distributed sliding window** — Multi-node consistency using Redis Cluster

## v4 — Observability & Dashboard

- [ ] **Prometheus metrics** — Export `gatekeeper_requests_total`, `gatekeeper_limited_total`
- [ ] **Dashboard API** — `GET /gatekeeper/stats` endpoint with per-key usage
- [ ] **Dashboard UI** — Embeddable HTML/React component showing real-time usage
- [ ] **Webhook alerts** — Notify Slack/Discord when a key is rate limited repeatedly
- [ ] **Audit log** — Record who got rate limited, when, and why

## v5 — Edge & Serverless

- [ ] **Cloudflare Workers store** — Use Cloudflare KV/Durable Objects instead of Redis
- [ ] **Upstash Redis** — HTTP-based Redis for serverless (no persistent connections)
- [ ] **Vercel Edge** — Rate limit at the edge before hitting your API
- [ ] **DynamoDB store** — For AWS Lambda deployments

## v6 — Enterprise Features

- [ ] **API key management** — Built-in API key → tier mapping
- [ ] **Quota system** — Monthly quotas (10,000 requests/month) separate from rate limits
- [ ] **Allowlist / Blocklist** — Bypass or block specific IPs/keys
- [ ] **Geo-based limits** — Different limits per region
- [ ] **Plugin system** — Community can add custom stores, algorithms, and adapters

## Good First Issues

Small, well-scoped tasks for new contributors:

- [ ] Add `leaky-bucket` algorithm
- [ ] Add `memcached` store
- [ ] Support `"1w"` (weeks) in duration parser
- [ ] Add `onLimitReached` callback hook
- [ ] Benchmark suite comparing all algorithms
- [ ] Migration guide from `express-rate-limit`
- [ ] Add examples directory with common patterns

## Integration with create-api-starterkit

- [ ] Add `--rate-limit` flag to `create-api-starterkit` that installs and configures Gatekeeper
- [ ] Provide a pre-built middleware setup in the generated project
