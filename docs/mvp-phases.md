# MVP implementation phases

## Phase 1 — independent foundation and discovery (complete)

- monorepo, container, health, and configuration baseline
- canonical Work/Edition types and PostgreSQL schema
- core provider/downloader/library contracts
- matcher, filter, dedupe, ranking, aggregation, and state-transition primitives
- Open Library metadata search API and responsive Discover UI

Exit: `pnpm check` passes and metadata search works through UI -> API -> adapter -> canonical DTO.

## Phase 2 — identity, tenancy, and profiles (core complete)

- bootstrap admin, password/session authentication, CSRF and rate limiting
- authorization service and redacted connection DTOs
- encrypted credential store and key rotation format
- management APIs for users, profiles, scoped connections, and libraries

Exit: cross-user authorization and secret non-disclosure integration tests pass.

Implemented: migration-backed administrator bootstrap, login/logout/current-session endpoints, Argon2id passwords, hashed session and CSRF tokens, user/profile/connection/library create-and-list endpoints, explicit shared-resource grants, encrypted connection credentials, redacted DTOs, and private-network URL restrictions. Update/delete/grant-management UI is intentionally deferred until Settings is implemented alongside Phase 3.

## Phase 3 — release inspection vertical slice (complete)

- Prowlarr and generic Newznab adapters with caps/connection tests
- concurrent aggregation, timeouts, normalized releases, matching, dedupe, filters, ranking
- request creation, shared acquisition identity, events, and release-inspection UI

Exit: Book -> Request -> ranked explainable releases works with one provider failing.

Implemented: canonical search results are persisted before request creation; Prowlarr and generic Newznab/NZBHydra-compatible adapters have connection tests, per-provider deadlines, redirect blocking, and normalized output; requests converge on compatible active acquisition jobs; searches persist bounded secret-free release snapshots and provider diagnostics; the UI creates requests and displays ranked releases with match reasons. Newznab book search falls back to general search only when the server explicitly reports the book function as unsupported.

## Phase 4 — acquisition and delivery

- TorBox adapter using only verified official endpoints and contract fixtures
- durable Redis-backed acquisition/download polling jobs
- Audiobookshelf connection/library selection, import/scan, and completion
- retries, WANTED scheduling, manual selection, and end-to-end auditing

Exit: an audiobook request reaches `AVAILABLE` in a real configured environment.

In progress: verified TorBox Usenet/magnet submission, polling, encrypted release references, Redis dispatch with PostgreSQL recovery, automatic/manual selection, WANTED rescheduling with bounded jittered backoff, temporary-link materialization, per-request delivery jobs, atomic filesystem import, and Audiobookshelf scans are implemented. The output layer now separates materialized library delivery from storage-light remote delivery. Per-user PageTurner sources reuse canonical metadata and ranked release aggregation, expose magnets or fresh remote-download redirects, and never persist temporary URLs or media. The single production image serves React and Fastify together. Protocol-faithful end-to-end runs prove both WANTED-to-remote-READY with zero local files and filesystem delivery to `AVAILABLE`. TorBox account-queue promotion and live TorBox/Audiobookshelf/PageTurner-device proof remain before the phase exit is met.

## Phase 5 — production hardening

- SSRF/DNS-rebinding/redirect tests, secret rotation, backup/restore guidance
- operational metrics, retention, graceful recovery, multi-arch image publishing
- full live-integration matrix and failure drills

Ebooks, extra clients/libraries, quality upgrades, and recommendations remain after the core MVP.
