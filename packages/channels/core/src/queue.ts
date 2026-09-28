import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

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

export const SEND_QUEUE = 'channel-send';

export interface SendJob {
  accountId: string;
  inboxId: string;
  /** A mensagem (`messages.id`) a enviar pelo canal. */
  messageId: string;
}

/**
 * Fila de envio pelo canal. Disparada pelo handler do evento `message.created` no worker (mensagem de saída
 * nascida `queued`). `jobId` fixo por mensagem: o mesmo envio nunca vira dois jobs.
 */
export function createSendQueue(connection: ConnectionOptions): Queue<SendJob> {
  return new Queue<SendJob>(SEND_QUEUE, {
    connection,
    defaultJobOptions: {
      attempts: 8,
      backoff: { type: 'exponential', delay: 1000, jitter: 0.5 },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    },
  });
}

export const enqueueSend = (queue: Queue<SendJob>, job: SendJob) =>
  queue.add('send', job, { jobId: `send-${job.messageId}` }).then(() => undefined);

/**
 * Diferente de `startInboundWorker`: o handler recebe o `Job` inteiro (não só os dados), porque a reconciliação
 * do envio (ADR 0011) precisa saber HÁ QUANTO TEMPO o job existe (`job.timestamp`) para decidir entre esperar o
 * webhook de status ou tentar de novo.
 */
export function startSendWorker(
  connection: ConnectionOptions,
  handler: (job: Job<SendJob>) => Promise<void>,
  onError?: (err: unknown) => void,
): Worker<SendJob> {
  const worker = new Worker<SendJob>(SEND_QUEUE, (job) => handler(job), {
    connection,
    concurrency: 4,
  });
  worker.on('failed', (_job, err) => onError?.(err));
  worker.on('error', (err) => onError?.(err));
  return worker;
}
