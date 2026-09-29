import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { signToken } from '../middleware/auth-hook.js';
import { AppError } from '../middleware/error-handler.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance) {
  app.post('/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const { rows } = await query(
      'SELECT id, email, name, password_hash, is_superadmin FROM users WHERE email = $1',
      [body.email],
    );

    if (rows.length === 0) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const user = rows[0];
    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const token = signToken({
      id: user.id,
      email: user.email,
      name: user.name,
      is_superadmin: user.is_superadmin,
    });

    reply
      .setCookie('token', token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 60 * 60 * 24,
      })
      .send({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          is_superadmin: user.is_superadmin,
        },
      });
  });

  app.post('/logout', async (_request, reply) => {
    reply.clearCookie('token', { path: '/' }).send({ ok: true });
  });

  app.get('/me', async (request, reply) => {
    if (!request.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'Not authenticated');
    }
    const { rows } = await query(
      `SELECT u.id, u.email, u.name, u.is_superadmin,
              json_agg(json_build_object('team_id', m.team_id, 'role', m.role, 'team_name', t.name)) AS memberships
       FROM users u
       LEFT JOIN memberships m ON m.user_id = u.id
       LEFT JOIN teams t ON t.id = m.team_id
       WHERE u.id = $1
       GROUP BY u.id`,
      [request.user.id],
    );
    reply.send(rows[0]);
  });
}
