# Engineering Decisions

## 1. Optimistic concurrency over pessimistic locking

Every PATCH and state transition on work_items requires the client to send the current `version` number. The UPDATE uses `WHERE version = $expected` and increments it atomically. If the version doesn't match, the server returns 409 with the current state, so the client can show the user what changed and let them decide.

I went with this over `SELECT ... FOR UPDATE` on the read path because pessimistic locking holds a row lock for the entire duration of the user's editing session -- or at least for the duration of the request, which still doesn't help if two users open the same item and both hit save. Optimistic locking catches that case cleanly. The trade-off is that the client has to handle 409 responses and present a conflict resolution UI, but that's the correct UX anyway: silently overwriting someone else's changes is worse than making the user look at the diff.

For the atomic claim endpoint, I do use a conditional UPDATE (`WHERE assignee_id IS NULL`), which is the right tool there since the "edit session" is zero-length -- there's nothing to show the user, just a winner and losers.

## 2. Postgres transactional outbox over a message broker

Side effects (notifications, future webhook delivery) are triggered through an outbox table. When the server writes a business change, it also inserts a row into `outbox` in the same transaction. A separate worker process polls with `SELECT ... FOR UPDATE SKIP LOCKED` and processes events.

I rejected Redis Streams or a dedicated queue because it adds an infrastructure dependency and a two-phase coordination problem: if the app writes to Postgres and then the Redis publish fails, you get inconsistency. The outbox pattern gives exactly-once delivery semantics (assuming idempotent handlers, which I enforce via `notifications.dedupe_key`). The downside is latency -- the worker polls on a 2-second interval, so notifications can lag by up to that much. At 10x scale I'd add a LISTEN/NOTIFY trigger on the outbox table to wake the worker immediately, or switch to something like Kafka with a proper CDC connector.

The worker uses exponential backoff on failures and marks rows as `failed` after 5 attempts. I'm not fully happy with having the retry logic inside the same process that does the polling -- in a production system I'd want a dead-letter queue with alerting, but for this scope it's adequate.

## 3. Authorization model and 404 policy

There's a single `authorize(membership, action, workItem, user)` function in `auth/authorize.ts` that every route calls. It takes a membership (which the route has already fetched for the user + team pair) and returns `{ allowed, reason }`. The route handlers use `requireTeamAccess()` first -- if the user isn't a member of the item's team, they get 404, not 403, so team existence and item existence aren't leaked to outsiders.

I considered RBAC with a permissions table, but the role set is small (member, lead, admin) and the rules are business-specific enough that a permissions table would just be indirection. A function with explicit if-statements is easier to test exhaustively and to read when debugging. The alternative I rejected was attribute-based access control (ABAC), which would be better if the permission model were more complex or user-configurable, but here it would be overengineering.

## 4. Keyset pagination and Postgres full-text search

List endpoints use keyset (cursor) pagination, encoding the sort columns of the last row into a base64url cursor. This avoids the correctness problems with OFFSET: rows inserted or deleted between pages cause duplicates or gaps with OFFSET, but keyset is stable because it always asks "give me rows after this specific row." The downside is you can't jump to page N, but for a work-item list with infinite scroll, that's fine.

For text search I used Postgres's built-in `tsvector` as a generated column with a GIN index, using `websearch_to_tsquery` for the query side. I rejected Elasticsearch or Meilisearch because they add infrastructure complexity and a synchronization problem. Postgres FTS is good enough for 20k items. The ranking is basic -- I weight the title higher (A) and description lower (B), but I don't use `ts_rank` for ordering since the primary sort is by updated_at. At larger scale the FTS performance might degrade and I'd consider a dedicated search index.

## 5. Append-only events in the same transaction

Every mutation on a work item (create, edit, claim, transition, approve, comment) writes a row to `work_item_events` inside the same transaction as the change. Events are never updated or deleted. This gives a complete audit trail that's trivially consistent with the work item state -- there's no possibility of a change happening without an event, or an event existing for a change that was rolled back.

I considered storing events in a separate database or using event sourcing, but the complexity isn't justified here. The current model is "state + events" rather than pure event sourcing: the work_items table is the source of truth for current state, and events are an append-only log for history. This keeps reads simple (no need to replay events to get current state) while still providing a full timeline. The trade-off is some data duplication -- the event payload records what changed, which is information also derivable from the before/after state -- but that's cheap and makes the timeline display fast without joining against historical snapshots.

## What I chose not to build

- **WebSocket push for real-time updates.** The detail view polls every 12 seconds and refetches on window focus. Polling is simpler and good enough for an internal tool. I'd add WebSockets if users complained about the lag.
- **Email or Slack notification delivery.** The notifications table exists and the outbox is wired up, but actual delivery would need SMTP/webhook integration that's outside scope.
- **Rate limiting.** Internal tool behind auth, but in production I'd add per-user rate limiting on mutations.
- **File attachments.** Would need an object store (S3) and a media table. Straightforward to add but not in scope.
- **Bulk operations.** No batch-assign, batch-close, etc. Would need a separate endpoint with its own concurrency and event logic.
