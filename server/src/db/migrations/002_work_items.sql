-- Work items with full-text search, events, comments

CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'pending_approval', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assignee_id uuid REFERENCES users(id),
  requires_approval boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES users(id),
  created_by uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'B')
  ) STORED
);

CREATE INDEX idx_work_items_list ON work_items(team_id, status, priority, updated_at);
CREATE INDEX idx_work_items_assignee ON work_items(assignee_id);
CREATE INDEX idx_work_items_search ON work_items USING gin(search);

CREATE TABLE work_item_events (
  id bigserial PRIMARY KEY,
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_item ON work_item_events(work_item_id, id);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id),
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_comments_item ON comments(work_item_id, created_at);
