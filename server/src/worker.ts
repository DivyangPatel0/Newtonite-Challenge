import { pool, query, transaction } from './db/pool.js';

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 2000;
const BASE_BACKOFF_MS = 1000;

interface OutboxRow {
  id: string;
  event_type: string;
  payload: any;
  attempts: number;
}

async function processOutbox() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<OutboxRow>(
      `SELECT id, event_type, payload, attempts FROM outbox
       WHERE status IN ('pending', 'processing')
         AND run_after <= now()
       ORDER BY id ASC
       LIMIT 10
       FOR UPDATE SKIP LOCKED`,
    );

    for (const row of rows) {
      try {
        await client.query(
          `UPDATE outbox SET status = 'processing', attempts = attempts + 1 WHERE id = $1`,
          [row.id],
        );

        await handleEvent(client, row);

        await client.query(
          `UPDATE outbox SET status = 'done' WHERE id = $1`,
          [row.id],
        );
      } catch (err: any) {
        const newAttempts = row.attempts + 1;
        if (newAttempts >= MAX_ATTEMPTS) {
          await client.query(
            `UPDATE outbox SET status = 'failed', last_error = $2 WHERE id = $1`,
            [row.id, err.message || String(err)],
          );
        } else {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, newAttempts);
          await client.query(
            `UPDATE outbox SET status = 'pending', last_error = $2, run_after = now() + interval '${backoff} milliseconds' WHERE id = $1`,
            [row.id, err.message || String(err)],
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Outbox processing error:', err);
  } finally {
    client.release();
  }
}

async function handleEvent(client: any, row: OutboxRow) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;

  switch (row.event_type) {
    case 'work_item_created':
      await notifyTeamMembers(client, payload.team_id, payload.work_item_id, 'item_created', payload.created_by);
      break;

    case 'work_item_claimed':
      await notifyItemStakeholders(client, payload.work_item_id, 'item_claimed', payload.claimed_by);
      break;

    case 'work_item_transitioned':
      await notifyItemStakeholders(client, payload.work_item_id, 'item_transitioned', payload.actor_id);
      break;

    case 'work_item_assigned':
      if (payload.assignee_id) {
        const dedupeKey = `assigned:${payload.work_item_id}:${payload.assignee_id}:${row.id}`;
        await insertNotification(client, payload.assignee_id, payload.work_item_id, 'assigned_to_you', dedupeKey);
      }
      break;

    case 'work_item_approved':
      await notifyItemStakeholders(client, payload.work_item_id, 'item_approved', payload.approved_by);
      break;

    case 'comment_added':
      await notifyItemStakeholders(client, payload.work_item_id, 'new_comment', payload.author_id);
      break;

    default:
      console.log(`Unknown event type: ${row.event_type}`);
  }
}

async function notifyTeamMembers(client: any, teamId: string, workItemId: string, kind: string, excludeUserId: string) {
  const { rows: members } = await client.query(
    'SELECT user_id FROM memberships WHERE team_id = $1 AND user_id != $2',
    [teamId, excludeUserId],
  );

  for (const member of members) {
    const dedupeKey = `${kind}:${workItemId}:${member.user_id}:${Date.now()}`;
    await insertNotification(client, member.user_id, workItemId, kind, dedupeKey);
  }
}

async function notifyItemStakeholders(client: any, workItemId: string, kind: string, excludeUserId: string) {
  // Notify assignee and creator (but not the person who did the action)
  const { rows: item } = await client.query(
    'SELECT assignee_id, created_by FROM work_items WHERE id = $1',
    [workItemId],
  );

  if (item.length === 0) return;
  const stakeholders = new Set<string>();
  if (item[0].assignee_id) stakeholders.add(item[0].assignee_id);
  if (item[0].created_by) stakeholders.add(item[0].created_by);
  stakeholders.delete(excludeUserId);

  for (const userId of stakeholders) {
    const dedupeKey = `${kind}:${workItemId}:${userId}:${Date.now()}`;
    await insertNotification(client, userId, workItemId, kind, dedupeKey);
  }
}

async function insertNotification(client: any, userId: string, workItemId: string, kind: string, dedupeKey: string) {
  await client.query(
    `INSERT INTO notifications (user_id, work_item_id, kind, dedupe_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [userId, workItemId, kind, dedupeKey],
  );
}

async function run() {
  console.log('Worker started, polling outbox...');
  while (true) {
    await processOutbox();
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

run().catch(err => {
  console.error('Worker crashed:', err);
  process.exit(1);
});
