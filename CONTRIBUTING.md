# Contributing to Gatekeeper

Thank you for your interest in contributing! Here's how to get started.

## Setup

```bash
git clone https://github.com/SibilSoren/gatekeeper.git
cd gatekeeper
npm install
```

## Development

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run lint          # Lint
npm run build         # Build
```

## Pull Request Process

1. Fork and create a feature branch from `main`
2. Write tests for your changes
3. Ensure `npm test` and `npm run lint` pass
4. Submit a PR with a clear description

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add leaky-bucket algorithm
fix: handle Redis connection timeout
docs: improve token-bucket example
```

## Code of Conduct

Be respectful. Be constructive. Be kind.
