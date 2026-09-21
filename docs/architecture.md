# AIOBooks architecture

## Product boundary

AIOBooks owns its domain, persistence, API, and UI. AIOStreams is inspiration only for the general aggregation pipeline: parallel providers, normalization, failure isolation, filtering, ranking, deduplication, and eventual early exit. No code or video-domain model is carried over.

## Runtime shape

```text
Web client
    | REST
API server ---- PostgreSQL (durable state)
    |  |
    |  +------ Redis (jobs, leases, rate coordination)
    |
    +-- metadata adapters -> canonical Work + Edition
    +-- search adapters ---\
                             normalize -> match -> dedupe -> filter -> rank
    +-- search adapters ---/                            |
                                                        v
                         request -> shared acquisition job -> download adapter
                                                           -> import adapter
                                                           -> library adapter
```

Routes orchestrate application services only. Provider response parsing and credentials never enter UI components or route-specific business logic.

## Package responsibilities

- `packages/core`: provider-neutral domain types, interfaces, matching, ranking, aggregation, and state transitions.
- `packages/metadata`: metadata adapters. Phase 1 contains Open Library.
- `packages/providers`: Prowlarr and Newznab-family release search adapters.
- `packages/downloaders`: downloader contracts and protocol-specific clients. TorBox is the first implementation.
- `packages/libraries`: atomic filesystem placement and Audiobookshelf scan adapters.
- `packages/database`: migrations and persistence adapters; domain packages do not import it.
- `apps/server`: transport, authentication/authorization, job orchestration, observability, and dependency wiring.
- `apps/web`: accessible user experience consuming only the REST contract.

Integrations live behind core interfaces and are grouped by capability, not by route. Routes select authorized resources; adapters alone own external protocol details.

## Aggregation lifecycle

1. Resolve query or identifier through a `MetadataProvider`.
2. Persist/upsert a canonical Work and its Editions.
3. Attach a user Request to a compatible in-flight AcquisitionJob, or create one transactionally.
4. Run enabled, authorized `SearchProvider`s concurrently with per-provider deadlines.
5. Preserve successful results when another provider errors or times out.
6. Parse every result into `NormalizedRelease`; provider payloads never escape the adapter.
7. Match against the requested Work/Edition. Exact identifiers dominate fuzzy signals; hard conflicts reject.
8. Deduplicate by protocol identity/content hash first and normalized release fingerprint second.
9. Apply profile filters, then score acceptable releases using profile-defined preferences.
10. Auto-select above the configured threshold or enter `MANUAL_REVIEW`/`WANTED`.
11. Send through a `DownloadClient`, monitor, import through a `LibraryProvider`, and fan completion out to all attached Requests.

The aggregator returns per-provider diagnostics and accepts an optional completion policy. Phase 1 waits for all providers; a later policy may stop only when a provably sufficient candidate exists.

## Security boundary

- Every user-owned row has `owner_user_id`; shareable resources also have explicit scope and grants.
- Connection secrets are encrypted before persistence with envelope/version metadata. Normal reads expose only redacted connection DTOs.
- Authorization is evaluated server-side for every resource and job attachment.
- User-configured URLs pass scheme, DNS, redirect, and resolved-address validation. Private/link-local/metadata networks are denied unless an administrator enables an explicit exception.
- Cookies are `HttpOnly`, `Secure` in production, and `SameSite=Lax`; state-changing cookie-authenticated requests require CSRF protection.
- Passwords use Argon2id. Opaque session and CSRF tokens are stored only as SHA-256 digests; session rows are revocable and expiring.
- Integration credentials are isolated from connection metadata and encrypted with versioned AES-256-GCM keys. Credential blobs are never part of API DTOs.
- Logs use structured fields and redact authorization, cookies, API keys, tokens, and connection secret blobs.

## External contracts verified for the implementation plan

- Open Library search: `GET https://openlibrary.org/search.json`; selected fields include `key`, `title`, `author_name`, identifiers, cover, and nested `editions`. Work and Edition identity are deliberately distinct.
- Newznab: compatible servers expose `GET /api` with `t=caps`, `t=book`, and the required general `t=search`; category IDs remain connection configuration rather than global assumptions. The adapter verifies caps and falls back from book search only when the server explicitly reports that function unsupported.
- Prowlarr: the adapter uses its published OpenAPI `GET /api/v1/system/status` and `GET /api/v1/search` contracts with `type=book` and configured categories.
- TorBox uses the official create/list/user endpoints, bearer authentication, and `downloadFinished` as the completion signal. CDN links are not persisted. Provider download references are stored only as independently encrypted release secrets.

## Observability

Every inbound request receives a correlation ID. Search execution records provider duration, outcome, raw count, normalized count, accepted count, and total pipeline duration without secret fields or raw authenticated URLs.
