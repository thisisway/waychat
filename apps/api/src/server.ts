import { coreConfigFromEnv, createCtx, fileServicesFromEnv } from '@waychat/core';
import { createDb } from '@waychat/db';
import { createRegistry, loadEnv, startMetricsServer } from '@waychat/shared';
import { createInboundQueue, enqueueInbound } from '@waychat/channels';
import { createScanQueue, enqueueScan } from '@waychat/storage';
import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { createRedisFeed } from './realtime.js';
import { telemetry } from './instrumentation.js';

const env = loadEnv();
const dbHandle = createDb(env.DATABASE_URL);
const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
// BullMQ exige uma conexão própria com `maxRetriesPerRequest: null`; a API só ENFILEIRA a varredura (o worker consome).
const scanQueue = createScanQueue(redis.duplicate({ maxRetriesPerRequest: null }));
const files = fileServicesFromEnv(env, (accountId, id) => enqueueScan(scanQueue, accountId, id));
if (env.NODE_ENV !== 'production') await files.store.ensureBucket?.();
if (!files.scanner) console.warn('CLAMAV_HOST vazio: anexos SEM varredura (só desenvolvimento)');
const inboundQueue = createInboundQueue(redis.duplicate({ maxRetriesPerRequest: null }));
const ctx = createCtx(dbHandle.db, coreConfigFromEnv(env), undefined, files, {
  enqueueInbound: (job) => enqueueInbound(inboundQueue, job),
});

const registry = createRegistry('api');
const metricsServer = startMetricsServer(registry, env.METRICS_PORT, env.METRICS_HOST);
const { app } = await buildApp({
  env,
  ctx,
  redis,
  metrics: registry,
  realtime: { feed: createRedisFeed(redis) },
});

// Graceful shutdown: para de aceitar conexões, termina as requisições em andamento e só então fecha as dependências.
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'encerrando');
  const timer = setTimeout(() => {
    app.log.error('timeout no encerramento; forçando saída');
    process.exit(1);
  }, 15_000);
  timer.unref();
  try {
    await app.close();
    await scanQueue.close();
    await inboundQueue.close();
    metricsServer.close();
    await dbHandle.close();
    await telemetry.shutdown();
    redis.disconnect();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'erro ao encerrar');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
