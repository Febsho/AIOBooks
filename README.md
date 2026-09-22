# AIOBooks

AIOBooks is an independent, self-hosted book and audiobook acquisition system. It resolves a user query to canonical work and edition metadata before searching acquisition sources, then normalizes, matches, filters, deduplicates, and ranks releases through provider-neutral contracts.

This repository is original AIOBooks code. It is not a fork of AIOStreams and contains no Stremio, film/TV, streaming, video-quality, TMDB, or IMDb assumptions.

## Current phase

Phases 1 through 3 are complete. Phase 4 now includes the end-to-end acquisition pipeline:

- React discovery UI
- Fastify REST API and health endpoints
- Open Library work/edition search adapter
- provider, downloader, library, parser, matcher, and ranking contracts
- real book-title/author/identifier matching and configurable ranking
- PostgreSQL schema with multi-user ownership and shared acquisition jobs
- Docker Compose development/deployment baseline
- PostgreSQL migration runner and one-time administrator bootstrap
- Argon2id authentication, hashed opaque sessions, synchronizer-token CSRF protection
- explicitly scoped users, profiles, connections, and libraries
- versioned AES-256-GCM credential encryption with secret-free API responses
- Prowlarr and generic Newznab/NZBHydra-compatible search adapters
- concurrent provider isolation, normalization, matching, filtering, deduplication, and ranking
- shared acquisition jobs with separate per-user requests
- persisted, explainable release inspection without exposing download URLs or provider identities
- encrypted release download references separated from user-visible snapshots
- manual ranked-release selection with transactional auditing
- Redis-backed durable TorBox submission and polling with PostgreSQL recovery
- TorBox contract adapters for Usenet and magnet downloads
- temporary TorBox link materialization into persistent staging without storing CDN URLs
- per-request delivery jobs with bounded retries and independent destinations
- automatic best-release selection plus explicit manual selection
- durable WANTED retries with bounded exponential backoff, jitter, and stale-search recovery
- atomic filesystem delivery and idempotent Audiobookshelf scan retries
- provider-neutral materialized and remote output contracts
- per-user, revocable PageTurner Download Sources for direct-download, torrent, and stream result shapes
- remote TorBox resolution without storing media or short-lived URLs on the AIOBooks host
- one production image (`ghcr.io/febsho/aiobooks`) serving React and `/api` from one port

See [Architecture](docs/architecture.md), [data model](docs/data-model.md), and [MVP phases](docs/mvp-phases.md).

## Local development

```bash
cp .env.example .env
pnpm install
pnpm dev
```

The web app runs at `http://localhost:5173`; the API runs at `http://localhost:3000`.

The first start requires `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD`. Remove the bootstrap password after the administrator has been created. Set `CREDENTIAL_ENCRYPTION_KEY` to a persistent 32-byte base64 key before creating integrations.

## Validation

```bash
pnpm check
docker compose config
docker compose up -d
```

Production Compose exposes the combined AIOBooks frontend/API on `${AIOBOOKS_PORT:-8080}`. PostgreSQL and Redis remain separate services.
