import { schema, type Db } from '@waychat/db';
import { eventEnvelopeSchema, type EventEnvelope } from '@waychat/shared';
import { asc, inArray, isNull } from 'drizzle-orm';

export interface RelayOptions {
  /** Conexão da role `waychat_relay` (lê o outbox de TODOS os tenants; só pode marcar `published_at`). */
  db: Db;
  /**
   * Entrega o lote ao transporte (fila + pub/sub). Deve ser idempotente por `event_id`: em caso de queda entre a
   * publicação e o COMMIT, o mesmo evento é publicado de novo (entrega at-least-once) e os consumidores deduplicam.
   */
  publish: (events: EventEnvelope[]) => Promise<void>;
  batchSize?: number;
}

/**
 * Um ciclo do relay: trava um lote de eventos pendentes (`FOR UPDATE SKIP LOCKED`: vários relays podem rodar em paralelo
 * sem pegar o mesmo evento), publica e só então marca `published_at` — tudo numa transação.
 * Se publicar falhar, dá ROLLBACK: nada é marcado, e o próximo ciclo reenvia. Nenhum evento se perde.
 * Retorna quantos eventos foram publicados.
 */
export async function relayOnce({ db, publish, batchSize = 100 }: RelayOptions): Promise<number> {
  const { outbox } = schema;
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(outbox)
      .where(isNull(outbox.publishedAt))
      .orderBy(asc(outbox.cursor))
      .limit(batchSize)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return 0;

    const events = rows.map((r) =>
      eventEnvelopeSchema.parse({
        event_id: r.id,
        cursor: r.cursor,
        account_id: r.accountId,
        type: r.eventType,
        occurred_at: r.createdAt.toISOString(),
        ...(r.traceContext ? { trace_context: r.traceContext } : {}),
        payload: r.payload,
      }),
    );
    await publish(events);
    await tx
      .update(outbox)
      .set({ publishedAt: new Date() })
      .where(
        inArray(
          outbox.id,
          rows.map((r) => r.id),
        ),
      );
    return rows.length;
  });
}

export interface RelayLoop {
  /** Para de buscar novos lotes e espera o lote em andamento terminar. */
  stop: () => Promise<void>;
}

/**
 * Laço de polling. Com lote cheio, continua sem pausa (escoando backlog); com lote parcial ou vazio, espera `intervalMs`.
 * Erros (banco, Valkey fora do ar) não derrubam o processo: espera com backoff exponencial + jitter e tenta de novo.
 */
export function startRelay(
  opts: RelayOptions & {
    intervalMs?: number;
    onError?: (err: unknown) => void;
    onPublished?: (n: number) => void;
  },
): RelayLoop {
  const batch = opts.batchSize ?? 100;
  const interval = opts.intervalMs ?? 500;
  let stopping = false as boolean; // lido no laço, escrito por stop()
  let failures = 0;
  let wake: (() => void) | undefined;
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });

  const done = (async () => {
    while (!stopping) {
      try {
        const n = await relayOnce(opts);
        failures = 0;
        if (n > 0) opts.onPublished?.(n);
        if (n < batch) await sleep(interval);
      } catch (err) {
        failures++;
        opts.onError?.(err);
        await sleep(backoffMs(failures, 500, 30_000));
      }
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await done;
    },
  };
}

/** Backoff exponencial com "full jitter": sorteia entre 0 e min(teto, base·2^tentativa). Evita que todos reconectem juntos. */
export function backoffMs(
  attempt: number,
  baseMs: number,
  capMs: number,
  random = Math.random,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
