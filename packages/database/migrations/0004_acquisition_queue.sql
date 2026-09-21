BEGIN;

CREATE TABLE release_secrets (
  release_id uuid PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  encrypted_data bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE acquisition_jobs ADD COLUMN selected_release_id uuid REFERENCES releases(id) ON DELETE RESTRICT;
ALTER TABLE download_jobs ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE download_jobs ADD COLUMN last_error text;
ALTER TABLE download_jobs ADD COLUMN next_poll_at timestamptz;

CREATE INDEX download_jobs_poll_idx ON download_jobs(next_poll_at)
  WHERE state IN ('QUEUED', 'DOWNLOADING');

COMMIT;
