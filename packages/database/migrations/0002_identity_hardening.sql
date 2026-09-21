ALTER TABLE sessions
  ADD COLUMN user_agent text,
  ADD COLUMN ip_address inet,
  ADD COLUMN revoked_at timestamptz;

CREATE INDEX sessions_active_user_idx
  ON sessions(user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE profile_permissions (
  profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_use boolean NOT NULL DEFAULT true,
  can_manage boolean NOT NULL DEFAULT false,
  PRIMARY KEY(profile_id, user_id)
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX connections_owner_scope_idx ON connections(owner_user_id, scope);
CREATE INDEX profiles_owner_scope_idx ON profiles(owner_user_id, scope);
CREATE INDEX libraries_owner_scope_idx ON libraries(owner_user_id, scope);
