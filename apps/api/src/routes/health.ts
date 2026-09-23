import { pingDb, type Db } from '@waychat/db';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { access } from '../types.js';

/** `live`: o processo responde. `ready`: as dependências (Postgres, Valkey) respondem — usado pelo orquestrador para tirar a instância do balanceador. */
export function healthRoutes(app: FastifyInstance, deps: { db: Db; redis?: Redis | null }): void {
  app.get('/health/live', { config: access.public }, () => ({ status: 'ok' }));

  app.get('/health/ready', { config: access.public }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    try {
      await pingDb(deps.db);
      checks['postgres'] = 'ok';
    } catch {
      checks['postgres'] = 'fail';
    }
    if (deps.redis) {
      try {
        await deps.redis.ping();
        checks['valkey'] = 'ok';
      } catch {
        checks['valkey'] = 'fail';
      }
    }
    const healthy = Object.values(checks).every((v) => v === 'ok');
    return reply.status(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks });
  });
}
