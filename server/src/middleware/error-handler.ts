import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function errorHandler(
  error: FastifyError | Error,
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }

  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request',
        details: error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
    });
  }

  const fastifyErr = error as FastifyError;
  if (fastifyErr.statusCode) {
    return reply.status(fastifyErr.statusCode).send({
      error: {
        code: fastifyErr.code || 'REQUEST_ERROR',
        message: fastifyErr.message,
      },
    });
  }

  console.error('Unhandled error:', error);
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
  });
}
