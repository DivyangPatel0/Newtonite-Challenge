import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, query, transaction } from '../db/pool.js';
import { requireTeamAccess, authorize, getUserMemberships } from '../auth/authorize.js';
import { isValidTransition, requiresApprovalStep, getAllowedTransitions } from '../workflow.js';
import { AppError } from '../middleware/error-handler.js';
import { idempotencyCheck, saveIdempotencyResult } from '../middleware/idempotency.js';
import type { AuthUser } from '../middleware/auth-hook.js';

const createSchema = z.object({
  team_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(10000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  requires_approval: z.boolean().default(false),
  assignee_id: z.string().uuid().nullable().optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  requires_approval: z.boolean().optional(),
  version: z.number().int().positive(),
});

const transitionSchema = z.object({
  status: z.enum(['open', 'in_progress', 'pending_approval', 'resolved', 'closed']),
  version: z.number().int().positive(),
});

const assignSchema = z.object({
  assignee_id: z.string().uuid().nullable(),
  version: z.number().int().positive(),
});

const listSchema = z.object({
  team_id: z.string().uuid().optional(),
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(['updated_at', 'priority']).default('updated_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
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

export async function workItemRoutes(app: FastifyInstance) {
  // List work items with filtering, search, keyset pagination
  app.get('/', async (request, reply) => {
    const user = requireUser(request);
    const params = listSchema.parse(request.query);
    const memberships = await getUserMemberships(user.id);

    if (memberships.length === 0) {
      return reply.send({ items: [], next_cursor: null });
    }

    const teamIds = params.team_id
      ? (memberships.some(m => m.team_id === params.team_id) ? [params.team_id] : [])
      : memberships.map(m => m.team_id);

    if (teamIds.length === 0) {
      return reply.send({ items: [], next_cursor: null });
    }

    const conditions: string[] = ['wi.team_id = ANY($1)'];
    const values: any[] = [teamIds];
    let paramIdx = 2;

    if (params.status) {
      conditions.push(`wi.status = $${paramIdx}`);
      values.push(params.status);
      paramIdx++;
    }

    if (params.priority) {
      conditions.push(`wi.priority = $${paramIdx}`);
      values.push(params.priority);
      paramIdx++;
    }

    if (params.assignee) {
      if (params.assignee === 'me') {
        conditions.push(`wi.assignee_id = $${paramIdx}`);
        values.push(user.id);
        paramIdx++;
      } else if (params.assignee === 'unassigned') {
        conditions.push('wi.assignee_id IS NULL');
      } else {
        conditions.push(`wi.assignee_id = $${paramIdx}`);
        values.push(params.assignee);
        paramIdx++;
      }
    }

    if (params.search) {
      conditions.push(`wi.search @@ websearch_to_tsquery('english', $${paramIdx})`);
      values.push(params.search);
      paramIdx++;
    }

    // Keyset pagination
    if (params.cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString());
        if (params.sort === 'updated_at') {
          if (params.direction === 'desc') {
            conditions.push(`(wi.updated_at, wi.id) < ($${paramIdx}, $${paramIdx + 1})`);
          } else {
            conditions.push(`(wi.updated_at, wi.id) > ($${paramIdx}, $${paramIdx + 1})`);
          }
          values.push(decoded.updated_at, decoded.id);
        } else {
          // priority sort uses a numeric mapping for stable ordering
          if (params.direction === 'desc') {
            conditions.push(`(priority_rank(wi.priority), wi.updated_at, wi.id) < ($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`);
          } else {
            conditions.push(`(priority_rank(wi.priority), wi.updated_at, wi.id) > ($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2})`);
          }
          values.push(decoded.priority_rank, decoded.updated_at, decoded.id);
        }
        paramIdx += params.sort === 'updated_at' ? 2 : 3;
      } catch {
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
      }
    }

    const where = conditions.join(' AND ');
    let orderBy: string;
    if (params.sort === 'updated_at') {
      orderBy = `wi.updated_at ${params.direction}, wi.id ${params.direction}`;
    } else {
      orderBy = `priority_rank(wi.priority) ${params.direction}, wi.updated_at DESC, wi.id DESC`;
    }

    const sql = `
      SELECT wi.*,
             u_assignee.name AS assignee_name,
             u_creator.name AS creator_name,
             t.name AS team_name
      FROM work_items wi
      LEFT JOIN users u_assignee ON u_assignee.id = wi.assignee_id
      LEFT JOIN users u_creator ON u_creator.id = wi.created_by
      LEFT JOIN teams t ON t.id = wi.team_id
      WHERE ${where}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx}
    `;
    values.push(params.limit + 1);

    const { rows } = await query(sql, values);
    const hasMore = rows.length > params.limit;
    const items = hasMore ? rows.slice(0, params.limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore) {
      const last = items[items.length - 1];
      const cursorData: any = { updated_at: last.updated_at, id: last.id };
      if (params.sort === 'priority') {
        cursorData.priority_rank = priorityRank(last.priority);
      }
      nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64url');
    }

    // Strip search tsvector from response
    const cleaned = items.map(({ search, ...rest }: any) => rest);
    reply.send({ items: cleaned, next_cursor: nextCursor });
  });

  // Create work item
  app.post('/', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const body = createSchema.parse(request.body);
    const membership = await requireTeamAccess(user.id, body.team_id);
    if (!membership) {
      throw new AppError(404, 'NOT_FOUND', 'Team not found');
    }

    if (body.priority === 'critical') {
      const auth = authorize(membership, 'set_critical');
      if (!auth.allowed) {
        throw new AppError(403, 'FORBIDDEN', auth.reason || 'Not allowed');
      }
    }

    const result = await transaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO work_items (team_id, title, description, priority, requires_approval, assignee_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [body.team_id, body.title, body.description, body.priority, body.requires_approval, body.assignee_id || null, user.id],
      );
      const item = rows[0];

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'created', $3)`,
        [item.id, user.id, JSON.stringify({ title: body.title, priority: body.priority })],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('work_item_created', $1)`,
        [JSON.stringify({ work_item_id: item.id, team_id: body.team_id, created_by: user.id })],
      );

      return item;
    });

    const { search, ...cleaned } = result;
    const responseBody = cleaned;
    const status = 201;

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, status, responseBody);
    }

    reply.status(status).send(responseBody);
  });

  // Get single work item
  app.get('/:id', async (request, reply) => {
    const user = requireUser(request);
    const id = validateUuid((request.params as { id: string }).id);

    const { rows } = await query(
      `SELECT wi.*,
              u_assignee.name AS assignee_name,
              u_creator.name AS creator_name,
              u_approver.name AS approver_name,
              t.name AS team_name
       FROM work_items wi
       LEFT JOIN users u_assignee ON u_assignee.id = wi.assignee_id
       LEFT JOIN users u_creator ON u_creator.id = wi.created_by
       LEFT JOIN users u_approver ON u_approver.id = wi.approved_by
       LEFT JOIN teams t ON t.id = wi.team_id
       WHERE wi.id = $1`,
      [id],
    );

    if (rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }

    const item = rows[0];
    // non-member gets 404, not 403
    const membership = await requireTeamAccess(user.id, item.team_id);
    if (!membership) {
      throw new AppError(404, 'NOT_FOUND', 'Work item not found');
    }

    const { search, ...cleaned } = item;
    reply.send({ ...cleaned, allowed_transitions: getAllowedTransitions(item.status) });
  });

  // Patch work item (optimistic concurrency)
  app.patch('/:id', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);
    const body = patchSchema.parse(request.body);

    const result = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM work_items WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (existing.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const item = existing[0];
      const membership = await requireTeamAccess(user.id, item.team_id, client);
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const auth = authorize(membership, 'edit', item, user);
      if (!auth.allowed) {
        throw new AppError(403, 'FORBIDDEN', auth.reason || 'Not allowed');
      }

      if (body.priority === 'critical' && item.priority !== 'critical') {
        const critAuth = authorize(membership, 'set_critical');
        if (!critAuth.allowed) {
          throw new AppError(403, 'FORBIDDEN', 'Only lead or admin can set critical priority');
        }
      }

      // Optimistic concurrency check
      if (item.version !== body.version) {
        const { search, ...cleaned } = item;
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      const updates: string[] = [];
      const vals: any[] = [];
      let idx = 1;
      const changes: Record<string, { from: any; to: any }> = {};

      for (const field of ['title', 'description', 'priority', 'requires_approval'] as const) {
        if (body[field] !== undefined && body[field] !== item[field]) {
          updates.push(`${field} = $${idx}`);
          vals.push(body[field]);
          changes[field] = { from: item[field], to: body[field] };
          idx++;
        }
      }

      if (updates.length === 0) {
        const { search, ...cleaned } = item;
        return cleaned;
      }

      updates.push(`version = version + 1`);
      updates.push(`updated_at = now()`);

      vals.push(id, body.version);
      const { rows: updated } = await client.query(
        `UPDATE work_items SET ${updates.join(', ')} WHERE id = $${idx} AND version = $${idx + 1} RETURNING *`,
        vals,
      );

      if (updated.length === 0) {
        const { rows: fresh } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
        const { search, ...cleaned } = fresh[0];
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'updated', $3)`,
        [id, user.id, JSON.stringify({ changes })],
      );

      const { search, ...cleaned } = updated[0];
      return cleaned;
    });

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 200, result);
    }

    reply.send(result);
  });

  // Claim (atomic conditional update)
  app.post('/:id/claim', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);

    const result = await transaction(async (client) => {
      // First check existence and access
      const { rows: check } = await client.query(
        'SELECT team_id, assignee_id FROM work_items WHERE id = $1',
        [id],
      );

      if (check.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const membership = await requireTeamAccess(user.id, check[0].team_id, client);
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      // Atomic claim: only succeeds if assignee is still null
      const { rows: claimed } = await client.query(
        `UPDATE work_items
         SET assignee_id = $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND assignee_id IS NULL
         RETURNING *`,
        [user.id, id],
      );

      if (claimed.length === 0) {
        // Someone else already claimed it
        const { rows: current } = await client.query(
          `SELECT wi.assignee_id, u.name AS assignee_name
           FROM work_items wi LEFT JOIN users u ON u.id = wi.assignee_id
           WHERE wi.id = $1`,
          [id],
        );
        throw new AppError(409, 'ALREADY_CLAIMED', 'Work item is already assigned', {
          assignee_id: current[0].assignee_id,
          assignee_name: current[0].assignee_name,
        });
      }

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'claimed', '{}')`,
        [id, user.id],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('work_item_claimed', $1)`,
        [JSON.stringify({ work_item_id: id, claimed_by: user.id })],
      );

      const { search, ...cleaned } = claimed[0];
      return cleaned;
    });

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 200, result);
    }

    reply.send(result);
  });

  // Transition status
  app.post('/:id/transition', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);
    const body = transitionSchema.parse(request.body);

    const result = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM work_items WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (existing.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const item = existing[0];
      const membership = await requireTeamAccess(user.id, item.team_id, client);
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      if (item.version !== body.version) {
        const { search, ...cleaned } = item;
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      // close requires lead/admin
      const action = body.status === 'closed' ? 'close' as const : 'transition' as const;
      const auth = authorize(membership, action, item, user);
      if (!auth.allowed) {
        throw new AppError(403, 'FORBIDDEN', auth.reason || 'Not allowed');
      }

      if (!isValidTransition(item.status, body.status)) {
        throw new AppError(422, 'INVALID_TRANSITION', `Cannot transition from ${item.status} to ${body.status}`, {
          allowed: getAllowedTransitions(item.status),
        });
      }

      if (requiresApprovalStep(item.status, body.status, item.requires_approval)) {
        throw new AppError(422, 'APPROVAL_REQUIRED', 'This item requires approval before it can be resolved. Move to pending_approval first.');
      }

      // pending_approval -> resolved requires that it was approved
      if (item.status === 'pending_approval' && body.status === 'resolved' && item.requires_approval && !item.approved_by) {
        throw new AppError(422, 'NOT_APPROVED', 'This item has not been approved yet');
      }

      const { rows: updated } = await client.query(
        `UPDATE work_items SET status = $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND version = $3 RETURNING *`,
        [body.status, id, body.version],
      );

      if (updated.length === 0) {
        const { rows: fresh } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
        const { search, ...cleaned } = fresh[0];
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'transitioned', $3)`,
        [id, user.id, JSON.stringify({ from: item.status, to: body.status })],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('work_item_transitioned', $1)`,
        [JSON.stringify({ work_item_id: id, from: item.status, to: body.status, actor_id: user.id })],
      );

      const { search, ...cleaned } = updated[0];
      return cleaned;
    });

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 200, result);
    }

    reply.send(result);
  });

  // Assign
  app.post('/:id/assign', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);
    const body = assignSchema.parse(request.body);

    const result = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM work_items WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (existing.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const item = existing[0];
      const membership = await requireTeamAccess(user.id, item.team_id, client);
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const auth = authorize(membership, 'assign', item, user);
      if (!auth.allowed) {
        throw new AppError(403, 'FORBIDDEN', auth.reason || 'Not allowed');
      }

      if (item.version !== body.version) {
        const { search, ...cleaned } = item;
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      // If assigning to someone, verify they are a team member
      if (body.assignee_id) {
        const targetMembership = await requireTeamAccess(body.assignee_id, item.team_id, client);
        if (!targetMembership) {
          throw new AppError(422, 'INVALID_ASSIGNEE', 'User is not a member of this team');
        }
      }

      const { rows: updated } = await client.query(
        `UPDATE work_items SET assignee_id = $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND version = $3 RETURNING *`,
        [body.assignee_id, id, body.version],
      );

      if (updated.length === 0) {
        const { rows: fresh } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
        const { search, ...cleaned } = fresh[0];
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'assigned', $3)`,
        [id, user.id, JSON.stringify({ assignee_id: body.assignee_id, previous_assignee_id: item.assignee_id })],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('work_item_assigned', $1)`,
        [JSON.stringify({ work_item_id: id, assignee_id: body.assignee_id, actor_id: user.id })],
      );

      const { search, ...cleaned } = updated[0];
      return cleaned;
    });

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 200, result);
    }

    reply.send(result);
  });

  // Approve
  app.post('/:id/approve', async (request, reply) => {
    const user = requireUser(request);
    const { isReplay, key, hash } = await idempotencyCheck(request, reply);
    if (isReplay) return;

    const id = validateUuid((request.params as { id: string }).id);
    const body = z.object({ version: z.number().int().positive() }).parse(request.body);

    const result = await transaction(async (client) => {
      const { rows: existing } = await client.query(
        'SELECT * FROM work_items WHERE id = $1 FOR UPDATE',
        [id],
      );

      if (existing.length === 0) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const item = existing[0];
      const membership = await requireTeamAccess(user.id, item.team_id, client);
      if (!membership) {
        throw new AppError(404, 'NOT_FOUND', 'Work item not found');
      }

      const auth = authorize(membership, 'approve', item, user);
      if (!auth.allowed) {
        throw new AppError(403, 'FORBIDDEN', auth.reason || 'Not allowed');
      }

      if (item.status !== 'pending_approval') {
        throw new AppError(422, 'INVALID_STATE', 'Item must be in pending_approval status to approve');
      }

      if (!item.requires_approval) {
        throw new AppError(422, 'INVALID_STATE', 'Item does not require approval');
      }

      // Cannot approve your own item (self-approval blocked)
      if (item.assignee_id === user.id) {
        throw new AppError(422, 'SELF_APPROVAL', 'Cannot approve your own assigned item');
      }

      if (item.version !== body.version) {
        const { search, ...cleaned } = item;
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      const { rows: updated } = await client.query(
        `UPDATE work_items SET approved_by = $1, version = version + 1, updated_at = now()
         WHERE id = $2 AND version = $3 RETURNING *`,
        [user.id, id, body.version],
      );

      if (updated.length === 0) {
        const { rows: fresh } = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
        const { search, ...cleaned } = fresh[0];
        throw new AppError(409, 'VERSION_CONFLICT', 'Work item has been modified', { current: cleaned });
      }

      await client.query(
        `INSERT INTO work_item_events (work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'approved', '{}')`,
        [id, user.id],
      );

      await client.query(
        `INSERT INTO outbox (event_type, payload)
         VALUES ('work_item_approved', $1)`,
        [JSON.stringify({ work_item_id: id, approved_by: user.id })],
      );

      const { search, ...cleaned } = updated[0];
      return cleaned;
    });

    if (key && hash) {
      await saveIdempotencyResult(user.id, key, hash, 200, result);
    }

    reply.send(result);
  });
}

function priorityRank(priority: string): number {
  switch (priority) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}
