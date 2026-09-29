import bcrypt from 'bcrypt';
import { pool, query, transaction } from './pool.js';
import crypto from 'crypto';

const SALT_ROUNDS = 10;
const DEFAULT_PASSWORD = 'password123';

const TEAM_NAMES = ['Engineering', 'Operations', 'Customer Support', 'Infrastructure'];

const STATUSES = ['open', 'in_progress', 'pending_approval', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const TITLES = [
  'Fix login timeout issue', 'Upgrade database driver', 'Review access control policy',
  'Investigate slow API response', 'Deploy monitoring dashboard', 'Patch security vulnerability',
  'Migrate legacy service', 'Set up CI pipeline', 'Resolve DNS configuration', 'Add error tracking',
  'Refactor authentication module', 'Update SSL certificates', 'Optimize database queries',
  'Create runbook for incidents', 'Review third-party integrations', 'Set up staging environment',
  'Fix memory leak in worker', 'Add request rate limiting', 'Implement backup strategy',
  'Audit user permissions', 'Replace deprecated library', 'Configure load balancer',
  'Add health check endpoint', 'Fix data export bug', 'Update API documentation',
  'Resolve intermittent test failures', 'Set up log aggregation', 'Fix email notification delivery',
  'Migrate to new hosting provider', 'Implement feature flags', 'Add database connection pooling',
  'Fix race condition in checkout', 'Update dependency versions', 'Create disaster recovery plan',
  'Fix broken pagination', 'Add input validation', 'Optimize image processing',
  'Fix timezone handling', 'Add retry logic for webhooks', 'Review and rotate API keys',
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed() {
  console.log('Seeding database...');

  const hash = await bcrypt.hash(DEFAULT_PASSWORD, SALT_ROUNDS);

  // Create teams
  const teams: { id: string; name: string }[] = [];
  for (const name of TEAM_NAMES) {
    const { rows } = await query(
      `INSERT INTO teams (name, description) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET name = $1
       RETURNING id, name`,
      [name, `The ${name} team`],
    );
    teams.push(rows[0]);
  }

  // Create 30 users
  const users: { id: string; email: string; name: string }[] = [];
  const firstNames = ['Alice', 'Bob', 'Carol', 'Dan', 'Eve', 'Frank', 'Grace', 'Hank',
    'Ivy', 'Jack', 'Kate', 'Leo', 'Mia', 'Nick', 'Olivia', 'Pat', 'Quinn', 'Ray',
    'Sam', 'Tina', 'Uma', 'Vince', 'Wendy', 'Xander', 'Yuki', 'Zara', 'Arjun',
    'Beatrice', 'Carlos', 'Diana'];

  for (let i = 0; i < 30; i++) {
    const name = firstNames[i];
    const email = `${name.toLowerCase()}@example.com`;
    const isSuperadmin = i === 0; // Alice is superadmin
    const { rows } = await query(
      `INSERT INTO users (email, password_hash, name, is_superadmin)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = $3
       RETURNING id, email, name`,
      [email, hash, name, isSuperadmin],
    );
    users.push(rows[0]);
  }

  // Assign memberships: each user in 1-3 teams, with varied roles
  // First 4 users are leads of each team, next 4 are admins
  const membershipPairs = new Set<string>();

  for (let t = 0; t < teams.length; t++) {
    // Lead
    const leadUser = users[t];
    await upsertMembership(leadUser.id, teams[t].id, 'lead');
    membershipPairs.add(`${leadUser.id}:${teams[t].id}`);

    // Admin
    const adminUser = users[t + 4];
    await upsertMembership(adminUser.id, teams[t].id, 'admin');
    membershipPairs.add(`${adminUser.id}:${teams[t].id}`);
  }

  // Remaining users get 1-3 team memberships as members
  for (let i = 8; i < users.length; i++) {
    const numTeams = randomInt(1, 3);
    const shuffled = [...teams].sort(() => Math.random() - 0.5);
    for (let t = 0; t < numTeams; t++) {
      const key = `${users[i].id}:${shuffled[t].id}`;
      if (!membershipPairs.has(key)) {
        await upsertMembership(users[i].id, shuffled[t].id, 'member');
        membershipPairs.add(key);
      }
    }
  }

  // Some leads/admins also join other teams as members for cross-team visibility
  for (let i = 0; i < 8; i++) {
    const otherTeam = teams[(i + 2) % teams.length];
    const key = `${users[i].id}:${otherTeam.id}`;
    if (!membershipPairs.has(key)) {
      await upsertMembership(users[i].id, otherTeam.id, 'member');
      membershipPairs.add(key);
    }
  }

  // Build a map of team -> members for assigning work items
  const teamMembers: Record<string, string[]> = {};
  for (const team of teams) {
    const { rows } = await query(
      'SELECT user_id FROM memberships WHERE team_id = $1',
      [team.id],
    );
    teamMembers[team.id] = rows.map(r => r.user_id);
  }

  // Create 20k work items with events
  console.log('Creating 20,000 work items (this takes a minute)...');
  const BATCH_SIZE = 500;
  const TOTAL_ITEMS = 20000;

  for (let batch = 0; batch < TOTAL_ITEMS; batch += BATCH_SIZE) {
    const end = Math.min(batch + BATCH_SIZE, TOTAL_ITEMS);
    await transaction(async (client) => {
      for (let i = batch; i < end; i++) {
        const team = randomItem(teams);
        const members = teamMembers[team.id];
        const creator = randomItem(members);
        const status = randomItem(STATUSES);
        const priority = randomItem(PRIORITIES);
        const title = randomItem(TITLES) + ` (#${i + 1})`;
        const requiresApproval = Math.random() < 0.2;
        const hasAssignee = status !== 'open' || Math.random() < 0.3;
        const assignee = hasAssignee ? randomItem(members) : null;

        // For items in resolved/closed with requires_approval, add an approver
        let approvedBy = null;
        if (requiresApproval && (status === 'resolved' || status === 'closed')) {
          const otherMembers = members.filter(m => m !== assignee);
          approvedBy = otherMembers.length > 0 ? randomItem(otherMembers) : null;
        }

        const version = randomInt(1, 5);
        const daysAgo = randomInt(0, 90);
        const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
        const updatedAt = new Date(createdAt.getTime() + randomInt(0, daysAgo) * 24 * 60 * 60 * 1000);

        const { rows } = await client.query(
          `INSERT INTO work_items (team_id, title, description, status, priority, assignee_id, requires_approval, approved_by, created_by, version, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [team.id, title, `Description for: ${title}`, status, priority, assignee, requiresApproval, approvedBy, creator, version, createdAt, updatedAt],
        );

        await client.query(
          `INSERT INTO work_item_events (work_item_id, actor_id, type, payload, created_at)
           VALUES ($1, $2, 'created', $3, $4)`,
          [rows[0].id, creator, JSON.stringify({ title, priority }), createdAt],
        );
      }
    });
    process.stdout.write(`  ${end}/${TOTAL_ITEMS}\r`);
  }

  console.log('\nSeed complete.\n');
  console.log('Demo credentials (all passwords: password123):');
  console.log('---');
  console.log('Superadmin:  alice@example.com');
  console.log('Team leads:  alice@example.com (Engineering), bob@example.com (Operations), carol@example.com (Customer Support), dan@example.com (Infrastructure)');
  console.log('Team admins: eve@example.com (Engineering), frank@example.com (Operations), grace@example.com (Customer Support), hank@example.com (Infrastructure)');
  console.log('Members:     ivy@example.com, jack@example.com, kate@example.com, ... zara@example.com');
  console.log('---');

  await pool.end();
}

async function upsertMembership(userId: string, teamId: string, role: string) {
  await query(
    `INSERT INTO memberships (user_id, team_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, team_id) DO UPDATE SET role = $3`,
    [userId, teamId, role],
  );
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
