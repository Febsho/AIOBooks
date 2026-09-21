BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_role AS ENUM ('ADMIN', 'USER');
CREATE TYPE resource_scope AS ENUM ('PRIVATE', 'SHARED');
CREATE TYPE media_type AS ENUM ('AUDIOBOOK', 'EBOOK');
CREATE TYPE request_state AS ENUM ('PENDING', 'SEARCHING', 'MATCHED', 'QUEUED', 'DOWNLOADING', 'PROCESSING', 'IMPORTING', 'AVAILABLE', 'WANTED', 'FAILED', 'MANUAL_REVIEW');
CREATE TYPE job_state AS ENUM ('PENDING', 'SEARCHING', 'MATCHED', 'QUEUED', 'DOWNLOADING', 'PROCESSING', 'IMPORTING', 'AVAILABLE', 'WANTED', 'FAILED', 'MANUAL_REVIEW');
CREATE TYPE connection_kind AS ENUM ('PROWLARR', 'NEWZNAB', 'TORZNAB', 'NZBHYDRA', 'TORBOX', 'SABNZBD', 'NZBGET', 'QBITTORRENT');
CREATE TYPE library_kind AS ENUM ('AUDIOBOOKSHELF', 'FILESYSTEM', 'WEBDAV');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'USER',
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_secret_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_name text NOT NULL,
  sort_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  subtitle text,
  description text,
  first_published_year integer,
  cover_url text,
  series_name text,
  series_position numeric(8,3),
  genres jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata_provider text NOT NULL,
  metadata_provider_id text NOT NULL,
  metadata_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(metadata_provider, metadata_provider_id)
);

CREATE TABLE book_authors (
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY(book_id, author_id)
);

CREATE TABLE editions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  title text NOT NULL,
  subtitle text,
  publisher text,
  published_at text,
  languages text[] NOT NULL DEFAULT '{}',
  media_types media_type[] NOT NULL DEFAULT '{}',
  duration_seconds integer,
  metadata_provider text NOT NULL,
  metadata_provider_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(metadata_provider, metadata_provider_id),
  CONSTRAINT edition_duration_positive CHECK (duration_seconds IS NULL OR duration_seconds > 0)
);
CREATE INDEX editions_book_id_idx ON editions(book_id);

CREATE TABLE edition_contributors (
  edition_id uuid NOT NULL REFERENCES editions(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES authors(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('AUTHOR', 'NARRATOR')),
  position smallint NOT NULL DEFAULT 0,
  PRIMARY KEY(edition_id, author_id, role)
);

CREATE TABLE identifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id uuid REFERENCES books(id) ON DELETE CASCADE,
  edition_id uuid REFERENCES editions(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('ISBN_10', 'ISBN_13', 'ASIN', 'OPEN_LIBRARY', 'GOOGLE_BOOKS', 'AUDIBLE')),
  value text NOT NULL,
  normalized_value text NOT NULL,
  CONSTRAINT identifier_single_owner CHECK ((book_id IS NOT NULL)::int + (edition_id IS NOT NULL)::int = 1)
);
CREATE UNIQUE INDEX identifiers_book_unique ON identifiers(book_id, type, normalized_value) WHERE book_id IS NOT NULL;
CREATE UNIQUE INDEX identifiers_edition_unique ON identifiers(edition_id, type, normalized_value) WHERE edition_id IS NOT NULL;
CREATE INDEX identifiers_lookup_idx ON identifiers(type, normalized_value);

CREATE TABLE profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope resource_scope NOT NULL DEFAULT 'PRIVATE',
  name text NOT NULL,
  media_type media_type NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, name)
);

CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope resource_scope NOT NULL DEFAULT 'PRIVATE',
  kind connection_kind NOT NULL,
  name text NOT NULL,
  base_url text NOT NULL,
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id, name)
);

CREATE TABLE connection_credentials (
  connection_id uuid PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE,
  key_version integer NOT NULL,
  encrypted_data bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE connection_permissions (
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_use boolean NOT NULL DEFAULT true,
  can_manage boolean NOT NULL DEFAULT false,
  PRIMARY KEY(connection_id, user_id)
);

CREATE TABLE libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope resource_scope NOT NULL DEFAULT 'PRIVATE',
  connection_id uuid REFERENCES connections(id) ON DELETE RESTRICT,
  kind library_kind NOT NULL,
  name text NOT NULL,
  external_library_id text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_permissions (
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_use boolean NOT NULL DEFAULT true,
  can_manage boolean NOT NULL DEFAULT false,
  PRIMARY KEY(library_id, user_id)
);

CREATE TABLE acquisition_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id uuid NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  media_type media_type NOT NULL,
  compatibility_key text NOT NULL,
  state job_state NOT NULL DEFAULT 'PENDING',
  selected_release jsonb,
  failure_code text,
  next_search_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX acquisition_jobs_active_unique ON acquisition_jobs(edition_id, media_type, compatibility_key)
  WHERE state NOT IN ('AVAILABLE', 'FAILED');

CREATE TABLE requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES editions(id) ON DELETE RESTRICT,
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  library_id uuid NOT NULL REFERENCES libraries(id) ON DELETE RESTRICT,
  media_type media_type NOT NULL,
  state request_state NOT NULL DEFAULT 'PENDING',
  automatic boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX requests_owner_created_idx ON requests(owner_user_id, created_at DESC);

CREATE TABLE acquisition_job_requests (
  acquisition_job_id uuid NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(acquisition_job_id, request_id),
  UNIQUE(request_id)
);

CREATE TABLE request_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  from_state request_state,
  to_state request_state NOT NULL,
  event_type text NOT NULL,
  public_message text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX request_events_request_idx ON request_events(request_id, id);

CREATE TABLE release_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_job_id uuid NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  correlation_id text NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_count integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_search_id uuid NOT NULL REFERENCES release_searches(id) ON DELETE CASCADE,
  provider_connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_release_id text NOT NULL,
  normalized_data jsonb NOT NULL,
  match_data jsonb NOT NULL,
  rank_score integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(release_search_id, provider_connection_id, provider_release_id)
);

CREATE TABLE download_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquisition_job_id uuid NOT NULL UNIQUE REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  external_job_id text,
  state text NOT NULL CHECK (state IN ('QUEUED', 'DOWNLOADING', 'COMPLETED', 'FAILED')),
  progress numeric(5,2),
  output_manifest jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT download_progress_range CHECK (progress IS NULL OR progress BETWEEN 0 AND 100)
);

COMMIT;
