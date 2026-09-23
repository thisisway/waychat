import { createDb } from '@waychat/db';
import { createLogger, createRegistry, loadEnv, startMetricsServer } from '@waychat/shared';
import { Redis } from 'ioredis';
import { telemetry } from './instrumentation.js';
import { registerWorkerMetrics } from './metrics.js';
import {
  bullConnection,
  createDeadLetterQueue,
  createEventsQueue,
  createPublisher,
  startEventsWorker,
} from './queues.js';
import { startRelay } from './relay.js';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL, 'worker');

if (!env.DATABASE_RELAY_URL) {
  log.fatal('DATABASE_RELAY_URL não definida: o relay do outbox usa a role waychat_relay');
  process.exit(1);
}

const relayDb = createDb(env.DATABASE_RELAY_URL, { max: 2 });
const redis = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 2 });
const connection = bullConnection(redis);
const queue = createEventsQueue(connection);
const deadLetter = createDeadLetterQueue(connection);

const registry = createRegistry('worker');
const metrics = registerWorkerMetrics(registry, { db: relayDb.db, queue, deadLetter });
const metricsServer = startMetricsServer(registry, env.WORKER_METRICS_PORT, env.METRICS_HOST);

const relay = startRelay({
  db: relayDb.db,
  publish: createPublisher(queue, redis),
  onPublished: (n) => {
    metrics.published.inc(n);
    log.debug({ n }, 'eventos publicados');
  },
  onError: (err) => {
    metrics.relayErrors.inc();
    log.error({ err }, 'falha no relay do outbox; nova tentativa com backoff');
  },
});

// Fases seguintes registram aqui os handlers (automações, webhooks de saída, envio por canal...).
const worker = startEventsWorker({
  connection,
  handlers: {},
  deadLetter,
  onError: (err, job) => {
    metrics.handlerFailures.inc();
    log.error({ err, job_id: job?.id }, 'falha ao processar evento');
  },
});

log.info('worker iniciado');

// Graceful shutdown: para o relay, termina os jobs em andamento e só então fecha as conexões.
let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'encerrando');
  const timer = setTimeout(() => {
    log.error('timeout no encerramento; forçando saída');
    process.exit(1);
  }, 30_000);
  timer.unref();
  try {
    await relay.stop();
    await worker.close();
    await queue.close();
    await deadLetter.close();
    await relayDb.close();
    metricsServer.close();
    await telemetry.shutdown();
    redis.disconnect();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'erro ao encerrar');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
