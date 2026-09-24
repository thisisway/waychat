import { Queue, Worker, type ConnectionOptions } from 'bullmq';

export const SCAN_QUEUE = 'attachment-scan';

export interface ScanJob {
  accountId: string;
  attachmentId: string;
}

/** Fila de varredura. `jobId` fixo por anexo: pedir duas vezes não cria dois jobs. */
export function createScanQueue(connection: ConnectionOptions): Queue<ScanJob> {
  return new Queue<ScanJob>(SCAN_QUEUE, {
    connection,
    defaultJobOptions: {
      // clamd fora do ar por alguns minutos não pode perder o arquivo: 10 tentativas com backoff exponencial
      attempts: 10,
      backoff: { type: 'exponential', delay: 2000, jitter: 0.5 },
      removeOnComplete: { age: 3600 },
      removeOnFail: false,
    },
  });
}

export const enqueueScan = (queue: Queue<ScanJob>, accountId: string, attachmentId: string) =>
  queue
    .add('scan', { accountId, attachmentId }, { jobId: `scan-${attachmentId}` })
    .then(() => undefined);

export function startScanWorker(
  connection: ConnectionOptions,
  handler: (job: ScanJob) => Promise<void>,
  onError?: (err: unknown) => void,
): Worker<ScanJob> {
  const worker = new Worker<ScanJob>(SCAN_QUEUE, (job) => handler(job.data), {
    connection,
    concurrency: 4,
  });
  worker.on('failed', (_job, err) => onError?.(err));
  worker.on('error', (err) => onError?.(err));
  return worker;
}
