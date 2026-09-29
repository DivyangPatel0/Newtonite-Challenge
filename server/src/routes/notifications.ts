import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { AppError } from '../middleware/error-handler.js';
import type { AuthUser } from '../middleware/auth-hook.js';

const listSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  unread_only: z.coerce.boolean().optional(),
});

function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  return request.user;
}

export async function notificationRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const user = requireUser(request);
    const params = listSchema.parse(request.query);

    const conditions = ['n.user_id = $1'];
    const values: any[] = [user.id];
    let paramIdx = 2;

    if (params.unread_only) {
      conditions.push('n.read_at IS NULL');
    }

    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString());
        conditions.push(`(n.created_at, n.id) < ($${paramIdx}, $${paramIdx + 1})`);
        values.push(decoded.created_at, decoded.id);
        paramIdx += 2;
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
      }
    }

    values.push(params.limit + 1);
    const sql = `
      SELECT n.*, wi.title AS work_item_title
      FROM notifications n
      LEFT JOIN work_items wi ON wi.id = n.work_item_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY n.created_at DESC, n.id DESC
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

    // Also get unread count
    const { rows: countRows } = await query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );

    reply.send({ items, next_cursor: nextCursor, unread_count: parseInt(countRows[0].count, 10) });
  });

  app.post('/read', async (request, reply) => {
    const user = requireUser(request);
    const body = z.object({
      notification_ids: z.array(z.string().uuid()),
    }).parse(request.body);

    await query(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL`,
      [user.id, body.notification_ids],
    );

    reply.send({ ok: true });
  });

  app.post('/read-all', async (request, reply) => {
    const user = requireUser(request);
    await query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [user.id],
    );
    reply.send({ ok: true });
  });
}
