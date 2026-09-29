import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { getUserMemberships } from '../auth/authorize.js';
import { AppError } from '../middleware/error-handler.js';
import type { AuthUser } from '../middleware/auth-hook.js';

function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  return request.user;
}

const STALE_DAYS = 7;

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request, reply) => {
    const user = requireUser(request);
    const memberships = await getUserMemberships(user.id);

    if (memberships.length === 0) {
      return reply.send({
        assigned_to_me: { count: 0, items: [] },
        awaiting_my_approval: { count: 0, items: [] },
        unassigned_high_priority: { count: 0, items: [] },
        stale_items: { count: 0, items: [] },
      });
    }

    const teamIds = memberships.map(m => m.team_id);
    const leadTeamIds = memberships
      .filter(m => m.role === 'lead' || m.role === 'admin')
      .map(m => m.team_id);

    // All computed in SQL, no full table loads
    const [assignedRes, approvalRes, unassignedRes, staleRes] = await Promise.all([
      query(
        `SELECT wi.id, wi.title, wi.status, wi.priority, wi.updated_at, t.name AS team_name
         FROM work_items wi JOIN teams t ON t.id = wi.team_id
         WHERE wi.assignee_id = $1 AND wi.status NOT IN ('closed', 'resolved')
         ORDER BY wi.updated_at DESC LIMIT 10`,
        [user.id],
      ),
      leadTeamIds.length > 0
        ? query(
            `SELECT wi.id, wi.title, wi.status, wi.priority, wi.updated_at, t.name AS team_name
             FROM work_items wi JOIN teams t ON t.id = wi.team_id
             WHERE wi.team_id = ANY($1) AND wi.status = 'pending_approval'
               AND wi.assignee_id IS DISTINCT FROM $2 AND wi.approved_by IS NULL
             ORDER BY wi.updated_at DESC LIMIT 10`,
            [leadTeamIds, user.id],
          )
        : { rows: [] },
      query(
        `SELECT wi.id, wi.title, wi.status, wi.priority, wi.updated_at, t.name AS team_name
         FROM work_items wi JOIN teams t ON t.id = wi.team_id
         WHERE wi.team_id = ANY($1) AND wi.assignee_id IS NULL
           AND wi.priority IN ('high', 'critical') AND wi.status NOT IN ('closed', 'resolved')
         ORDER BY wi.updated_at DESC LIMIT 10`,
        [teamIds],
      ),
      query(
        `SELECT wi.id, wi.title, wi.status, wi.priority, wi.updated_at, t.name AS team_name
         FROM work_items wi JOIN teams t ON t.id = wi.team_id
         WHERE wi.team_id = ANY($1) AND wi.status NOT IN ('closed', 'resolved')
           AND wi.updated_at < now() - interval '${STALE_DAYS} days'
         ORDER BY wi.updated_at ASC LIMIT 10`,
        [teamIds],
      ),
    ]);

    // Get counts separately to avoid loading everything
    const [assignedCount, approvalCount, unassignedCount, staleCount] = await Promise.all([
      query(
        `SELECT COUNT(*) AS count FROM work_items
         WHERE assignee_id = $1 AND status NOT IN ('closed', 'resolved')`,
        [user.id],
      ),
      leadTeamIds.length > 0
        ? query(
            `SELECT COUNT(*) AS count FROM work_items
             WHERE team_id = ANY($1) AND status = 'pending_approval'
               AND assignee_id IS DISTINCT FROM $2 AND approved_by IS NULL`,
            [leadTeamIds, user.id],
          )
        : { rows: [{ count: '0' }] },
      query(
        `SELECT COUNT(*) AS count FROM work_items
         WHERE team_id = ANY($1) AND assignee_id IS NULL
           AND priority IN ('high', 'critical') AND status NOT IN ('closed', 'resolved')`,
        [teamIds],
      ),
      query(
        `SELECT COUNT(*) AS count FROM work_items
         WHERE team_id = ANY($1) AND status NOT IN ('closed', 'resolved')
           AND updated_at < now() - interval '${STALE_DAYS} days'`,
        [teamIds],
      ),
    ]);

    reply.send({
      assigned_to_me: { count: parseInt(assignedCount.rows[0].count, 10), items: assignedRes.rows },
      awaiting_my_approval: { count: parseInt(approvalCount.rows[0].count, 10), items: approvalRes.rows },
      unassigned_high_priority: { count: parseInt(unassignedCount.rows[0].count, 10), items: unassignedRes.rows },
      stale_items: { count: parseInt(staleCount.rows[0].count, 10), items: staleRes.rows },
    });
  });
}
