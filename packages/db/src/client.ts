import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export interface DbHandle {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pool: pg.Pool;
  close: () => Promise<void>;
}

export type Db = DbHandle['db'];

export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  const db = drizzle(pool, { schema, casing: 'snake_case' });
  return { db, pool, close: () => pool.end() };
}

/** Health check: uma ida e volta ao banco. */
export async function pingDb(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
