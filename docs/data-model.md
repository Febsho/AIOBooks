# Data model

The executable baseline is in `packages/database/migrations/0001_initial.sql`.

## Identity

- `books` represent canonical Works.
- `editions` represent published or recorded manifestations of a Work.
- `identifiers` attach typed external identities to exactly one Work or Edition.
- Authors are many-to-many with Works; narrators are many-to-many with Editions.

This separation prevents an ISBN for one translation or recording from becoming the identity of every edition.

## Ownership and sharing

Users and roles are explicit from the first migration. Profiles, connections, libraries, requests, download jobs, delivery jobs, integration tokens, remote requests, and remote outputs have ownership. A connection/profile/library is either `PRIVATE` or `SHARED`; access to a shared resource is still expressed through explicit permission rows. Secrets are stored in separate encrypted credential tables so list/detail queries cannot accidentally serialize them.

## Duplicate acquisition

`acquisition_jobs` are edition/media/profile-compatible work units. `acquisition_job_requests` is a many-to-many join. Creation uses a partial unique index over active acquisition identity plus a transaction/advisory lock so concurrent requests converge on one active job while retaining separate user-visible Requests.

## Durable versus ephemeral data

Canonical metadata, requests, state events, selected release snapshots, and jobs are durable. Search sessions retain diagnostics and only a bounded/redacted release snapshot; complete provider payloads are not permanent by default. `acquisition_jobs.attempt_count` and `next_search_at` make WANTED retries restart-safe without a parallel scheduler state store.

Release download references are separately encrypted. Temporary downloader URLs are never persisted. A completed download has one durable local manifest, while `delivery_jobs` track destination-specific retries and completion for each attached Request.

`integration_tokens` stores only a lookup hash plus an encrypted recoverable token for the authenticated Settings UI. `remote_requests` records the integration-specific lifecycle; `remote_outputs` stores encrypted magnets or opaque downloader file references and explicit `QUEUED`, `RESOLVING`, `READY`, `EXPIRED`, and `FAILED` states. Remote requests never use `AVAILABLE`, which remains reserved for a satisfied library destination.
