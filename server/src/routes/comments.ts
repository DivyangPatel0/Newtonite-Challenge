import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query, transaction } from '../db/pool.js';
import { requireTeamAccess } from '../auth/authorize.js';
import { AppError } from '../middleware/error-handler.js';
import { idempotencyCheck, saveIdempotencyResult } from '../middleware/idempotency.js';
import type { AuthUser } from '../middleware/auth-hook.js';

const createCommentSchema = z.object({
  body: z.string().min(1).max(5000),
});

const listCommentsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  return request.user;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateUuid(id: string): string {
  if (!UUID_RE.test(id)) throw new AppError(400, 'INVALID_ID', 'Invalid ID format');
  return id;
}

export async function commentRoutes(app: FastifyInstance) {
  // List comments for a work item
  app.get('/work-items/:id/comments', async (request, reply) => {
    const user = requireUser(request);
    const id = validateUuid((request.params as { id: string }).id);
    const params = listCommentsSchema.parse(request.query);

    const { rows: itemRows } = await query(
      'SELECT team_id FROM work_items WHERE id = $1',
      [id],
    );
    if (itemRows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }
    const membership = await requireTeamAccess(user.id, itemRows[0].team_id);
    if (!membership) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }

    const conditions = ['c.work_item_id = $1'];
    const values: any[] = [id];
    let paramIdx = 2;

    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString());
        conditions.push(`(c.created_at, c.id) > ($${paramIdx}, $${paramIdx + 1})`);
        values.push(decoded.created_at, decoded.id);
        paramIdx += 2;
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
      }
    }

    values.push(params.limit + 1);
    const sql = `
      SELECT c.*, u.name AS author_name
      FROM comments c
      JOIN users u ON u.id = c.author_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT $${paramIdx}
    `;

    const { rows } = await query(sql, values);
    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ created_at: last.created_at, id: last.id })).toString('base64url');
    }

    reply.send({ items, next_cursor: nextCursor });
  });

  // Create comment
  app.post('/work-items/:id/comments', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);
    const body = createCommentSchema.parse(request.body);

    const { rows: itemRows } = await query(
      'SELECT team_id FROM work_items WHERE id = $1',
      [id],
    );
    if (itemRows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }
    const membership = await requireTeamAccess(user.id, itemRows[0].team_id);
    if (!membership) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }

    const result = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO comments (work_item_id, author_id, body)
         VALUES ($1, $2, $3) RETURNING *`,
        [id, user.id, body.body],
      );

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'commented', $3)`,
        [id, user.id, JSON.stringify({ comment_id: rows[0].id })],
      );

      await client.query(
        `UPDATE work_items SET updated_at = now() WHERE id = $1`,
        [id],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('comment_added', $1)`,
        [JSON.stringify({ work_item_id: id, comment_id: rows[0].id, author_id: user.id })],
      );

      return rows[0];
    });

    const responseBody = result;
    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 201, responseBody);
    }

    reply.status(201).send(responseBody);
  });
}
