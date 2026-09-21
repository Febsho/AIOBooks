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
