BEGIN;

CREATE TABLE integration_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind = 'PAGETURNER'),
  token_hash bytea NOT NULL UNIQUE,
  key_version integer NOT NULL,
  encrypted_token bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, kind)
);

CREATE TABLE remote_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_token_id uuid NOT NULL REFERENCES integration_tokens(id) ON DELETE CASCADE,
  acquisition_job_id uuid NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
  output_type text NOT NULL CHECK (output_type IN ('torrent', 'directDownload', 'stream')),
  state text NOT NULL CHECK (state IN ('SEARCHING', 'WANTED', 'MATCHED', 'QUEUED', 'RESOLVING', 'READY', 'EXPIRED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX remote_requests_job_idx ON remote_requests(acquisition_job_id);
CREATE INDEX remote_requests_owner_idx ON remote_requests(owner_user_id, created_at DESC);

CREATE TABLE remote_request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  remote_request_id uuid NOT NULL REFERENCES remote_requests(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  event_type text NOT NULL,
  public_message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX remote_request_events_request_idx ON remote_request_events(remote_request_id, id);

CREATE TABLE remote_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_request_id uuid NOT NULL REFERENCES remote_requests(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  release_id uuid NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES connections(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('MAGNET', 'DIRECT_DOWNLOAD', 'STREAM', 'REFERENCE')),
  state text NOT NULL CHECK (state IN ('DISCOVERED', 'QUEUED', 'RESOLVING', 'READY', 'EXPIRED', 'FAILED')),
  external_job_id text,
  output_manifest jsonb,
  key_version integer,
  encrypted_reference bytea,
  nonce bytea,
  auth_tag bytea,
  expires_at timestamptz,
  next_poll_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(remote_request_id, release_id, kind),
  CONSTRAINT remote_reference_encryption_complete CHECK (
    (encrypted_reference IS NULL AND key_version IS NULL AND nonce IS NULL AND auth_tag IS NULL)
    OR (encrypted_reference IS NOT NULL AND key_version IS NOT NULL AND nonce IS NOT NULL AND auth_tag IS NOT NULL)
  )
);
CREATE INDEX remote_outputs_due_idx ON remote_outputs(next_poll_at)
  WHERE state IN ('QUEUED', 'RESOLVING', 'EXPIRED');

COMMIT;
