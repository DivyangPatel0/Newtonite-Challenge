import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-prod';
const PUBLIC_PATHS = ['/api/auth/login', '/api/auth/logout'];

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function authHook(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
) {
  if (PUBLIC_PATHS.includes(request.url.split('?')[0])) {
    done();
    return;
  }

  const token = request.cookies?.token;
  if (!token) {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthUser;
    request.user = payload;
    done();
  } catch {
    reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' },
    });
  }
}

export function signToken(user: AuthUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '24h' });
}
