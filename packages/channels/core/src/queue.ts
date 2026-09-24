import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const INBOUND_QUEUE = 'channel-inbound';

export interface InboundJob {
  accountId: string;
  inboxId: string;
  /** Linha de `inbound_events` a processar. */
  eventId: string;
}

/**
 * Fila de processamento dos webhooks. O handler HTTP só grava o evento bruto e enfileira; quem interpreta é o worker
 * (a Meta reenvia se o webhook demorar). `jobId` fixo por evento: enfileirar duas vezes não cria dois jobs.
 */
export function createInboundQueue(connection: ConnectionOptions): Queue<InboundJob> {
  return new Queue<InboundJob>(INBOUND_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    },
  });
}

export const enqueueInbound = (queue: Queue<InboundJob>, job: InboundJob) =>
  queue.add('inbound', job, { jobId: `in-${job.eventId}` }).then(() => undefined);

export function startInboundWorker(
  connection: ConnectionOptions,
  handler: (job: InboundJob) => Promise<void>,
  onError?: (err: unknown) => void,
): Worker<InboundJob> {
  const worker = new Worker<InboundJob>(INBOUND_QUEUE, (job) => handler(job.data), {
    connection,
    concurrency: 8,
  });
  worker.on('failed', (_job, err) => onError?.(err));
  worker.on('error', (err) => onError?.(err));
  return worker;
}
