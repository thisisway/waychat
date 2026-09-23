import { runMigrations } from './migrate.js';

const url = process.env['DATABASE_OWNER_URL'];
if (!url) {
  console.error('DATABASE_OWNER_URL não definida');
  process.exit(1);
}
await runMigrations(url);
console.log('migrações aplicadas');
