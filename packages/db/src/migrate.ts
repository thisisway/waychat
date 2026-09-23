import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

/** Aplica as migrações. Precisa da conexão do dono do schema (DATABASE_OWNER_URL), nunca da role da aplicação. */
export async function runMigrations(ownerUrl: string): Promise<void> {
  const { db, close } = createDb(ownerUrl, { max: 1 });
  try {
    await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  } finally {
    await close();
  }
}
