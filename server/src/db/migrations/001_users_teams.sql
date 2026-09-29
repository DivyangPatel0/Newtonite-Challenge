-- Initial schema: users, teams, memberships

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  is_superadmin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  team_id uuid NOT NULL REFERENCES teams(id),
  role text NOT NULL CHECK (role IN ('member', 'lead', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, team_id)
);

CREATE INDEX idx_memberships_team ON memberships(team_id);
