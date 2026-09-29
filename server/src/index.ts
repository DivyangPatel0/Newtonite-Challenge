import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { authRoutes } from './routes/auth.js';
import { workItemRoutes } from './routes/work-items.js';
import { commentRoutes } from './routes/comments.js';
import { eventRoutes } from './routes/events.js';
import { notificationRoutes } from './routes/notifications.js';
import { teamRoutes } from './routes/teams.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { errorHandler } from './middleware/error-handler.js';
import { authHook } from './middleware/auth-hook.js';

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
});

await app.register(cookie, {
  secret: process.env.COOKIE_SECRET || 'dev-cookie-secret-change-in-prod',
});

app.setErrorHandler(errorHandler);

app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!body || (typeof body === 'string' && body.trim() === '')) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body as string));
  } catch (err: any) {
    err.statusCode = 400;
    done(err, undefined);
  }
});

app.addHook('onRequest', authHook);

await app.register(authRoutes, { prefix: '/api/auth' });
await app.register(teamRoutes, { prefix: '/api/teams' });
await app.register(workItemRoutes, { prefix: '/api/work-items' });
await app.register(commentRoutes, { prefix: '/api' });
await app.register(eventRoutes, { prefix: '/api' });
await app.register(notificationRoutes, { prefix: '/api/notifications' });
await app.register(dashboardRoutes, { prefix: '/api' });

const port = parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

try {
  await app.listen({ port, host });
  console.log(`Server running on http://${host}:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
