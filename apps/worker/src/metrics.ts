import { schema, type Db } from '@waychat/db';
import { isNull, sql } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { Counter, Gauge, type Registry } from 'prom-client';

/**
 * Métricas do worker. Os gauges são calculados no momento da raspagem (`collect`), então refletem o estado real:
 * - `outbox_pending`: eventos gravados e ainda não publicados. Se crescer, o relay está parado ou lento.
 * - `queue_jobs{queue,state}`: profundidade das filas; `dead_letter` > 0 pede atenção humana.
 */
export function registerWorkerMetrics(
  registry: Registry,
  deps: { db: Db; queue: Queue; deadLetter: Queue },
) {
  new Gauge({
    name: 'outbox_pending',
    help: 'Eventos do outbox ainda não publicados',
    registers: [registry],
    async collect() {
      const [row] = await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.outbox)
        .where(isNull(schema.outbox.publishedAt));
      this.set(row?.n ?? 0);
    },
  });

  new Gauge({
    name: 'queue_jobs',
    help: 'Jobs por fila e estado',
    labelNames: ['queue', 'state'],
    registers: [registry],
    async collect() {
      for (const q of [deps.queue, deps.deadLetter]) {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts)) this.set({ queue: q.name, state }, n);
      }
    },
  });

  return {
    published: new Counter({
      name: 'outbox_published_total',
      help: 'Eventos publicados pelo relay',
      registers: [registry],
    }),
    relayErrors: new Counter({
      name: 'relay_errors_total',
      help: 'Falhas do ciclo do relay',
      registers: [registry],
    }),
    handlerFailures: new Counter({
      name: 'event_handler_failures_total',
      help: 'Falhas de handlers de evento (cada tentativa)',
      registers: [registry],
    }),
  };
}
