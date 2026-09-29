import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { AppError } from '../middleware/error-handler.js';
import type { AuthUser } from '../middleware/auth-hook.js';

function requireUser(request: { user?: AuthUser }): AuthUser {
  if (!request.user) throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
  return request.user;
}

export async function teamRoutes(app: FastifyInstance) {
  // List my teams
  app.get('/', async (request, reply) => {
    const user = requireUser(request);
    const { rows } = await query(
      `SELECT t.*, m.role
       FROM teams t
       JOIN memberships m ON m.team_id = t.id
       WHERE m.user_id = $1
       ORDER BY t.name`,
      [user.id],
    );
    reply.send({ teams: rows });
  });

  // List members of a team (only if you're a member)
  app.get('/:id/members', async (request, reply) => {
    const user = requireUser(request);
    const { id } = request.params as { id: string };

    const { rows: membership } = await query(
      'SELECT 1 FROM memberships WHERE user_id = $1 AND team_id = $2',
      [user.id, id],
    );
    if (membership.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Team not found');
    }

    const { rows } = await query(
      `SELECT u.id, u.email, u.name, m.role
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = $1
       ORDER BY u.name`,
      [id],
    );
    reply.send({ members: rows });
  });
}
