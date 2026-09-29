import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireTeamAccess } from '../auth/authorize.js';
import { AppError } from '../middleware/error-handler.js';
import type { AuthUser } from '../middleware/auth-hook.js';

const listEventsSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  return request.user;
}

export async function eventRoutes(app: FastifyInstance) {
  app.get('/work-items/:id/events', async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };
    const params = listEventsSchema.parse(request.query);

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

    const conditions = ['e.work_item_id = $1'];
    const values: any[] = [id];
    let paramIdx = 2;

    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString());
        conditions.push(`e.id > $${paramIdx}`);
        values.push(decoded.id);
        paramIdx++;
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid cursor');
      }
    }

    values.push(params.limit + 1);
    const sql = `
      SELECT e.*, u.name AS actor_name
      FROM work_item_events e
      JOIN users u ON u.id = e.actor_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.id ASC
      LIMIT $${paramIdx}
    `;

    const { rows } = await query(sql, values);
    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(JSON.stringify({ id: last.id })).toString('base64url');
    }

    reply.send({ items, next_cursor: nextCursor });
  });
}
