import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';

const INIT_SH = fileURLToPath(new URL('../../../infra/docker/postgres/init.sh', import.meta.url));

export interface TestDb {
  container: StartedPostgreSqlContainer;
  /** Conexão da aplicação (waychat_app): sujeita à RLS. */
  app: DbHandle;
  /** Conexão do relay do outbox (waychat_relay). */
  relay: DbHandle;
  /** Conexão do dono/superusuário (só para preparar cenários e checar o catálogo). */
  owner: DbHandle;
  stop: () => Promise<void>;
}

/** Sobe um Postgres real com o MESMO init.sh do docker-compose (roles, extensões, grants) e aplica as migrações. */
export async function startTestDb(): Promise<TestDb> {
  const container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('waychat')
    .withUsername('waychat_owner')
    .withPassword('owner-pw')
    .withEnvironment({ WAYCHAT_APP_PASSWORD: 'app-pw', WAYCHAT_RELAY_PASSWORD: 'relay-pw' })
    .withCopyFilesToContainer([
      { source: INIT_SH, target: '/docker-entrypoint-initdb.d/10-init.sh', mode: 0o755 },
    ])
    .start();

  const url = (user: string, pw: string) =>
    `postgres://${user}:${pw}@${container.getHost()}:${String(container.getPort())}/waychat`;
  await runMigrations(url('waychat_owner', 'owner-pw'));

  const owner = createDb(url('waychat_owner', 'owner-pw'), { max: 2 });
  const app = createDb(url('waychat_app', 'app-pw'), { max: 1 });
  const relay = createDb(url('waychat_relay', 'relay-pw'), { max: 2 });
  return {
    container,
    app,
    relay,
    owner,
    stop: async () => {
      await Promise.all([app.close(), relay.close(), owner.close()]);
      await container.stop();
    },
  };
}
