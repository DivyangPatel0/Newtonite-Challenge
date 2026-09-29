import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import { authRoutes } from '../routes/auth.js';
import { workItemRoutes } from '../routes/work-items.js';
import { commentRoutes } from '../routes/comments.js';
import { eventRoutes } from '../routes/events.js';
import { notificationRoutes } from '../routes/notifications.js';
import { teamRoutes } from '../routes/teams.js';
import { dashboardRoutes } from '../routes/dashboard.js';
import { errorHandler } from '../middleware/error-handler.js';
import { authHook, signToken } from '../middleware/auth-hook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test database config - uses the test Postgres from docker-compose
const TEST_DB = {
  host: process.env.TEST_DB_HOST || 'localhost',
  port: parseInt(process.env.TEST_DB_PORT || '5433', 10),
  user: process.env.TEST_DB_USER || 'worktracker_test',
  password: process.env.TEST_DB_PASSWORD || 'worktracker_test',
  database: process.env.TEST_DB_NAME || 'worktracker_test',
};

let testPool: pg.Pool;

export function getTestPool() {
  if (!testPool) {
    testPool = new pg.Pool(TEST_DB);
  }
  return testPool;
}

// Override the pool module to use test database
export async function setupTestDb() {
  const pool = getTestPool();

  // Run migrations
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const { rows: applied } = await pool.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.map((r: any) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
  }
}

export async function resetTestDb() {
  const pool = getTestPool();
  await pool.query(`
    TRUNCATE notifications, outbox, idempotency_keys, comments,
             work_item_events, work_items, memberships, users, teams CASCADE
  `);
}

export async function teardownTestDb() {
  if (testPool) {
    await testPool.end();
  }
}

// Monkey-patch the pool module to use test database.
// We do this by setting env vars before importing the app modules.
export function setTestEnv() {
  process.env.DB_HOST = TEST_DB.host;
  process.env.DB_PORT = String(TEST_DB.port);
  process.env.DB_USER = TEST_DB.user;
  process.env.DB_PASSWORD = TEST_DB.password;
  process.env.DB_NAME = TEST_DB.database;
}

export async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: 'test-secret' });

  app.setErrorHandler(errorHandler);
  app.addHook('onRequest', authHook);

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

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(teamRoutes, { prefix: '/api/teams' });
  await app.register(workItemRoutes, { prefix: '/api/work-items' });
  await app.register(commentRoutes, { prefix: '/api' });
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(dashboardRoutes, { prefix: '/api' });

  return app;
}

interface TestUser {
  id: string;
  email: string;
  name: string;
  is_superadmin: boolean;
}

export async function createTestUser(
  name: string,
  email: string,
  opts: { is_superadmin?: boolean } = {},
): Promise<TestUser> {
  const pool = getTestPool();
  const hash = await bcrypt.hash('password123', 4); // low rounds for speed
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, name, is_superadmin)
     VALUES ($1, $2, $3, $4) RETURNING id, email, name, is_superadmin`,
    [email, hash, name, opts.is_superadmin || false],
  );
  return rows[0];
}

export async function createTestTeam(name: string): Promise<{ id: string; name: string }> {
  const pool = getTestPool();
  const { rows } = await pool.query(
    'INSERT INTO teams (name) VALUES ($1) RETURNING id, name',
    [name],
  );
  return rows[0];
}

export async function addMembership(userId: string, teamId: string, role: string) {
  const pool = getTestPool();
  await pool.query(
    'INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)',
    [userId, teamId, role],
  );
}

export function authCookie(user: TestUser): string {
  return `token=${signToken(user)}`;
}
