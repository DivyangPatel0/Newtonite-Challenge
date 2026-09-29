# Defense Notes

## Request Flow Walkthrough

### Claim flow (POST /work-items/:id/claim)

1. Auth hook (middleware/auth-hook.ts) verifies the JWT cookie and attaches request.user.
2. Route handler in routes/work-items.ts calls idempotencyCheck() -- if this key was seen before with the same body, replay the stored response.
3. Opens a transaction via transaction() in db/pool.ts.
4. Checks item exists and user is a team member (requireTeamAccess()). Non-member gets 404.
5. Executes the atomic claim: UPDATE work_items SET assignee_id = , version = version + 1 WHERE id =  AND assignee_id IS NULL RETURNING *. This is a single statement -- Postgres guarantees that only one concurrent UPDATE will match the WHERE assignee_id IS NULL condition. The loser's UPDATE matches zero rows.
6. If zero rows returned, queries current assignee and returns 409 with ALREADY_CLAIMED and the winner's name.
7. If successful, inserts a work_item_events row (type: 'claimed') and an outbox row in the same transaction.
8. Commits transaction. Saves idempotency result if a key was provided.

### Edit flow (PATCH /work-items/:id)

1. Auth hook, idempotency check.
2. Zod validates request body including the required version field.
3. Transaction: SELECT * FROM work_items WHERE id =  FOR UPDATE (locks the row).
4. Team access check. Authorization check (authorize(membership, 'edit', item, user)).
5. Version comparison: if item.version !== body.version, return 409 with VERSION_CONFLICT and the current item state. The client shows "this item changed, here is what's different."
6. Build dynamic UPDATE with only changed fields, include version = version + 1, updated_at = now().
7. Execute UPDATE ... WHERE id =  AND version =  -- belt-and-suspenders check in case of TOCTOU between the SELECT FOR UPDATE and the UPDATE (shouldn't happen within the same transaction, but doesn't hurt).
8. Insert event, commit, save idempotency result.

### Idempotent retry

1. Client generates a UUID as Idempotency-Key header for each user action.
2. idempotencyCheck() in middleware/idempotency.ts hashes the request body with SHA-256.
3. Looks up idempotency_keys by (user_id, key).
4. If found with matching hash: return the stored response_status and response_body. No mutation happens.
5. If found with different hash: return 422 IDEMPOTENCY_MISMATCH.
6. If not found: proceed with the mutation. After success, saveIdempotencyResult() stores the response for future replays.

## Where each critical behaviour lives

- Atomic claim: routes/work-items.ts, app.post('/:id/claim'), the UPDATE ... WHERE assignee_id IS NULL query
- Optimistic concurrency: routes/work-items.ts, app.patch('/:id'), version comparison and UPDATE ... WHERE version = expected
- Idempotency: middleware/idempotency.ts, idempotencyCheck() and saveIdempotencyResult()
- Workflow transitions: workflow.ts, TRANSITIONS table, isValidTransition(), requiresApprovalStep()
- Authorization: auth/authorize.ts, authorize() function, requireTeamAccess()
- Self-approval block: routes/work-items.ts, app.post('/:id/approve'), check item.assignee_id === user.id
- Outbox processing: worker.ts, processOutbox() with FOR UPDATE SKIP LOCKED
- Notification dedup: worker.ts, insertNotification() with ON CONFLICT (dedupe_key) DO NOTHING
- Keyset pagination: routes/work-items.ts, app.get('/'), cursor encoding/decoding
- Event logging in transaction: all mutation routes insert into work_item_events inside the same transaction() call

## Failure modes

- Two users claim simultaneously: One gets 200, the other gets 409 with the winner's name.
- Edit with stale version: 409 with VERSION_CONFLICT and the current item state. Client shows diff.
- Same idempotency key, same body: Stored response is replayed. No duplicate mutation.
- Same idempotency key, different body: 422 IDEMPOTENCY_MISMATCH.
- Outbox handler crashes: Row stays, attempts incremented. After 5 failures, marked failed.
- Non-member accesses item: 404 (not 403), so team existence isn't leaked.
- Self-approval attempt: 422 SELF_APPROVAL.

## What I'd change at 10x scale

- Add LISTEN/NOTIFY on the outbox table to wake the worker instantly instead of polling every 2 seconds.
- Move to multiple worker processes. The FOR UPDATE SKIP LOCKED pattern already supports this.
- Add connection pooling with PgBouncer in front of Postgres.
- Replace JWT payload trust with a database lookup per request (cache in Redis with short TTL).
- Add a proper dead-letter queue and alerting for failed outbox events.
- Add rate limiting (sliding window counter per user).
- Consider read replicas for list queries and dashboard aggregations.

## What I'd build with another week

- WebSocket channel for real-time updates on the detail view (eliminate polling).
- SLA tracking: define target response times per priority level, show countdown timers.
- A proper audit log viewer with filtering by actor, action type, and date range.
- Bulk operations (batch assign, batch transition) with proper concurrency handling.
- File attachments via S3 presigned URLs.
- Email notification delivery from the outbox worker.
- Admin panel for managing teams, users, and memberships (currently seed-only).

## 5 likely "modify this live" requests

1. Add a new status to the workflow -- Edit the TRANSITIONS table in workflow.ts to add the new status and its allowed transitions. Add it to the CHECK constraint in a new migration. Update the Zod enum in transitionSchema in routes/work-items.ts. Update the CSS badge class in web/src/index.css.

2. Add a due_date field to work items -- New migration adding the column. Add to createSchema and patchSchema in routes/work-items.ts. Update the PATCH handler's field loop. Add to the detail view in WorkItemDetail.tsx.

3. Make the approval rule more specific (only admins can approve, not leads) -- Change the authorize() function in auth/authorize.ts: in the approve action case, check role === 'admin' instead of isLeadOrAdmin. Update the test in api.test.ts.

4. Add a watchers list so specific users get notified -- New watchers table (work_item_id, user_id). New endpoint to add/remove watchers. In worker.ts, modify notifyItemStakeholders() to also query the watchers table.

5. Show the full diff when a version conflict occurs -- In WorkItemDetail.tsx, when patchMutation's onError catches a VERSION_CONFLICT, parse err.details.current and compare field-by-field with the user's pending edits. Display a side-by-side diff. The server already returns the full current state in the 409 response.
