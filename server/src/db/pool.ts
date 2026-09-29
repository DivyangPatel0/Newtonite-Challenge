import pg from 'pg';

let _pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USER || 'worktracker',
      password: process.env.DB_PASSWORD || 'worktracker',
      database: process.env.DB_NAME || 'worktracker',
      max: parseInt(process.env.DB_POOL_SIZE || '10', 10),
    });
  }
  return _pool;
}

// Legacy export for code that references `pool` directly
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop, receiver) {
    return Reflect.get(getPool(), prop, receiver);
  },
});

export function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
