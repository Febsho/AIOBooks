# Request and acquisition state machine

```text
PENDING -> SEARCHING -> MATCHED -> QUEUED -> DOWNLOADING
                |                                |
                |                                v
                +-> WANTED                PROCESSING -> IMPORTING -> AVAILABLE
                |       ^                       |
                v       |                       v
          MANUAL_REVIEW-+--------------------> FAILED
```

Only transitions declared in `packages/core/src/state-machine.ts` are valid. Every transition and operator-visible detail is appended to `request_events` in the same database transaction as the request update.

- `WANTED` is retryable and scheduled with bounded exponential backoff plus jitter.
- `FAILED` is terminal for that attempt, not immutable history; an authorized retry creates a new attempt/event.
- `MANUAL_REVIEW` requires a user with release-selection permission.
- `AVAILABLE` is set per Request only after its authorized destination is satisfied, even when several Requests share one acquisition.

Remote integration requests use a separate lifecycle:

```text
SEARCHING -> MATCHED -> QUEUED -> RESOLVING -> READY
    |           |                    |           |
    v           |                    v           v
  WANTED <------+                  FAILED      EXPIRED
    ^                                              |
    +----------------------------------------------+
```

`READY` means the opaque reference can currently be resolved for the client; it does not mean AIOBooks materialized or imported media. Temporary URLs are generated on demand and are not persisted. `EXPIRED` is recoverable: the worker revalidates downloader state and returns to `READY` when a new URL can be generated.
