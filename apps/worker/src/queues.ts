import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { eventEnvelopeSchema, withEventSpan, type EventEnvelope } from '@waychat/shared';

export const EVENTS_QUEUE = 'domain-events';
export const DEAD_LETTER_QUEUE = 'domain-events-dlq';
export const eventsChannel = (accountId: string) => `wc:events:${accountId}`;

/** Tentativas por evento antes de ir para a dead-letter queue. */
export const MAX_ATTEMPTS = 8;

export interface QueueSettings {
  attempts: number;
  /** Atraso-base do backoff exponencial (ms). */
  backoffMs: number;
}

const DEFAULTS: QueueSettings = { attempts: MAX_ATTEMPTS, backoffMs: 1000 };

/** BullMQ exige `maxRetriesPerRequest: null` na conexão que ele usa. */
export function bullConnection(redis: Redis): ConnectionOptions {
  return redis.duplicate({ maxRetriesPerRequest: null });
}

export function createEventsQueue(
  connection: ConnectionOptions,
  s: QueueSettings = DEFAULTS,
): Queue {
  return new Queue(EVENTS_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: s.attempts,
      // exponencial com jitter de 50%: retries de muitos eventos não chegam todos ao mesmo tempo
      backoff: { type: 'exponential', delay: s.backoffMs, jitter: 0.5 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail: false,
    },
  });
}

export function createDeadLetterQueue(connection: ConnectionOptions): Queue {
  return new Queue(DEAD_LETTER_QUEUE, {
    connection,
    defaultJobOptions: { removeOnComplete: false },
  });
}

/**
 * Publicação do relay: enfileira um job por evento com `jobId = event_id` (o BullMQ ignora duplicatas: republicar
 * depois de uma queda não cria um segundo job) e faz fan-out em tempo real por pub/sub (o gateway WebSocket assina).
 */
export function createPublisher(queue: Queue, redis: Redis) {
  return async (events: EventEnvelope[]): Promise<void> => {
    await queue.addBulk(
      events.map((e) => ({ name: e.type, data: e, opts: { jobId: e.event_id } })),
    );
    if (events.length > 0) {
      const pipeline = redis.pipeline();
      for (const e of events) pipeline.publish(eventsChannel(e.account_id), JSON.stringify(e));
      await pipeline.exec();
    }
  };
}

export type EventHandler = (event: EventEnvelope) => Promise<void>;

export interface EventsWorkerOptions {
  connection: ConnectionOptions;
  handlers: Partial<Record<string, EventHandler>>;
  deadLetter: Queue;
  concurrency?: number;
  onError?: (err: unknown, job?: Job) => void;
}

/**
 * Consome os eventos. Falhou -> o BullMQ reenfileira com backoff; esgotadas as tentativas, o evento vai para a
 * dead-letter queue com o motivo, para inspeção e reprocesso manual (nunca é descartado em silêncio).
 */
export function startEventsWorker(o: EventsWorkerOptions): Worker {
  const worker = new Worker(
    EVENTS_QUEUE,
    async (job) => {
      const event = eventEnvelopeSchema.parse(job.data);
      const handler = o.handlers[event.type];
      if (!handler) return;
      await withEventSpan(
        `event ${event.type}`,
        event.trace_context,
        { 'event.id': event.event_id, 'event.type': event.type, 'account.id': event.account_id },
        () => handler(event),
      );
    },
    { connection: o.connection, concurrency: o.concurrency ?? 10 },
  );

  worker.on('failed', (job, err) => {
    o.onError?.(err, job);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void o.deadLetter
        .add(
          job.name,
          { event: job.data as unknown, reason: err.message, attempts: job.attemptsMade },
          { jobId: `dlq-${job.id ?? job.name}` },
        )
        .catch((e: unknown) => o.onError?.(e, job));
    }
  });
  worker.on('error', (err) => o.onError?.(err));
  return worker;
}
