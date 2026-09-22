BEGIN;

ALTER TABLE download_jobs ADD COLUMN materialization_started_at timestamptz;
ALTER TABLE download_jobs ADD COLUMN materialized_at timestamptz;

CREATE TABLE delivery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  acquisition_job_id uuid NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('QUEUED', 'IMPORTING', 'AVAILABLE', 'FAILED')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  imported_item_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX delivery_jobs_due_idx ON delivery_jobs(next_attempt_at)
  WHERE state IN ('QUEUED', 'IMPORTING');

COMMIT;
