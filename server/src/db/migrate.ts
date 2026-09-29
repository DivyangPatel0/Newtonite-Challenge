import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const { rows: applied } = await pool.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  const appliedSet = new Set(applied.map(r => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`  apply ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`  FAIL  ${file}:`, err);
      process.exit(1);
    } finally {
      client.release();
    }
  }

  console.log('Migrations complete.');
  await pool.end();
}

migrate();
