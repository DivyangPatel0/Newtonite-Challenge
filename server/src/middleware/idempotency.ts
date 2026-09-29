import crypto from 'crypto';
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';
import { query } from '../db/pool.js';

function hashBody(body: unknown): string {
  const str = JSON.stringify(body ?? {});
  return crypto.createHash('sha256').update(str).digest('hex');
}

export async function idempotencyCheck(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ isReplay: boolean; key?: string; hash?: string }> {
  const method = request.method;
  if (method !== 'POST' && method !== 'PATCH') {
    return { isReplay: false };
  }

  const key = request.headers['idempotency-key'] as string | undefined;
  if (!key) {
    return { isReplay: false };
  }

  const userId = request.user?.id;
  if (!userId) {
    return { isReplay: false };
  }

  const hash = hashBody(request.body);

  const { rows } = await query(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
    [userId, key],
  );

  if (rows.length > 0) {
    const existing = rows[0];
    if (existing.request_hash !== hash) {
      reply.status(422).send({
        error: {
          code: 'IDEMPOTENCY_MISMATCH',
          message: 'Idempotency key was already used with a different request body',
        },
      });
      return { isReplay: true };
    }
    reply.status(existing.response_status).send(existing.response_body);
    return { isReplay: true };
  }

  return { isReplay: false, key, hash };
}

export async function saveIdempotencyResult(
  userId: string,
  key: string,
  hash: string,
  status: number,
  body: unknown,
) {
  await query(
    `INSERT INTO idempotency_keys (key, user_id, request_hash, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, key) DO NOTHING`,
    [key, userId, hash, status, JSON.stringify(body)],
  );
}
