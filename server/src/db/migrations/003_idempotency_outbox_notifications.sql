-- Idempotency keys, outbox, notifications

CREATE TABLE idempotency_keys (
  key text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_outbox_pending ON outbox(status, run_after) WHERE status IN ('pending', 'processing');

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  work_item_id uuid REFERENCES work_items(id),
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
