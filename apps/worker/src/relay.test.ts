import { schema } from '@waychat/db';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { uuidv7, type EventEnvelope } from '@waychat/shared';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bullConnection,
  createDeadLetterQueue,
  createEventsQueue,
  createPublisher,
  eventsChannel,
  startEventsWorker,
} from './queues.js';
import { listenOutbox } from './notify.js';
import { backoffMs, relayOnce, startRelay } from './relay.js';

let t: TestDb;
let valkey: StartedTestContainer;
let redis: Redis;

const A = uuidv7();
const B = uuidv7();

async function seed(count: number, accountId = A) {
  await t.owner.db.insert(schema.outbox).values(
    Array.from({ length: count }, (_, i) => ({
      accountId,
      aggregateType: 'test',
      aggregateId: uuidv7(),
      eventType: 'member.removed',
      payload: { user_id: uuidv7(), i },
    })),
  );
}

const pending = async () => {
  const r = await t.owner.pool.query(
    'select count(*)::int as n from outbox where published_at is null',
  );
  return r.rows[0].n as number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(50);
  }
  throw new Error('timeout esperando condição');
}

beforeAll(async () => {
  [t, valkey] = await Promise.all([
    startTestDb(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start(),
  ]);
  redis = new Redis({
    host: valkey.getHost(),
    port: valkey.getMappedPort(6379),
    maxRetriesPerRequest: null,
  });
  for (const [id, slug] of [
    [A, 'a'],
    [B, 'b'],
  ] as const) {
    await t.owner.db.insert(schema.accounts).values({ id, name: slug, slug });
  }
});

afterAll(async () => {
  redis.disconnect();
  await valkey.stop();
  await t.stop();
});

beforeEach(async () => {
  await t.owner.pool.query('truncate outbox');
  await redis.flushall();
});

describe('backoff', () => {
  it('cresce exponencialmente, respeita o teto e usa jitter', () => {
    const max = () => 0.999999;
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 500, 100_000, max))).toEqual([
      499, 999, 1999, 3999,
    ]);
    expect(backoffMs(30, 500, 30_000, max)).toBeLessThan(30_000);
    expect(backoffMs(5, 500, 30_000, () => 0)).toBe(0); // jitter total pode dar 0
  });
});

describe('relay do outbox', () => {
  it('publica em ordem de cursor, marca como publicado e não republica', async () => {
    await seed(250);
    const seen: EventEnvelope[] = [];
    const publish = (evs: EventEnvelope[]) => {
      seen.push(...evs);
      return Promise.resolve();
    };
    let total = 0;
    for (
      let n = await relayOnce({ db: t.relay.db, publish, batchSize: 100 });
      n > 0;
      n = await relayOnce({ db: t.relay.db, publish, batchSize: 100 })
    )
      total += n;
    expect(total).toBe(250);
    expect(seen.map((e) => e.cursor)).toEqual([...seen.map((e) => e.cursor)].sort((a, b) => a - b));
    expect(new Set(seen.map((e) => e.event_id)).size).toBe(250);
    expect(await pending()).toBe(0);
    expect(await relayOnce({ db: t.relay.db, publish, batchSize: 100 })).toBe(0);
  });

  it('vários relays em paralelo nunca publicam o mesmo evento (SKIP LOCKED)', async () => {
    await seed(300);
    const counts = new Map<string, number>();
    const publish = async (evs: EventEnvelope[]) => {
      await sleep(20); // segura a transação aberta para forçar a concorrência
      for (const e of evs) counts.set(e.event_id, (counts.get(e.event_id) ?? 0) + 1);
    };
    const worker = async () => {
      let n = 1;
      while (n > 0) n = await relayOnce({ db: t.relay.db, publish, batchSize: 20 });
    };
    await Promise.all([worker(), worker(), worker()]);
    expect(counts.size).toBe(300);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
    expect(await pending()).toBe(0);
  });

  it('falha ao publicar: ROLLBACK, nada é marcado e o próximo ciclo reenvia tudo', async () => {
    await seed(10);
    await expect(
      relayOnce({ db: t.relay.db, publish: () => Promise.reject(new Error('valkey fora do ar')) }),
    ).rejects.toThrow(/valkey/);
    expect(await pending()).toBe(10);
    const got: string[] = [];
    await relayOnce({
      db: t.relay.db,
      publish: (e) => Promise.resolve(void got.push(...e.map((x) => x.event_id))),
    });
    expect(got).toHaveLength(10);
    expect(await pending()).toBe(0);
  });

  it('eventos de vários tenants passam pelo mesmo relay, cada um com o seu account_id', async () => {
    await seed(3, A);
    await seed(3, B);
    const seen: EventEnvelope[] = [];
    await relayOnce({ db: t.relay.db, publish: (e) => Promise.resolve(void seen.push(...e)) });
    expect(seen.filter((e) => e.account_id === A)).toHaveLength(3);
    expect(seen.filter((e) => e.account_id === B)).toHaveLength(3);
  });

  it('QUEDA no meio (publicou e não deu commit): reenvio não cria job duplicado nem perde evento', async () => {
    await seed(40);
    const conn = bullConnection(redis);
    const queue = createEventsQueue(conn);
    const real = createPublisher(queue, redis);
    let crashed = false;
    const flaky = async (evs: EventEnvelope[]) => {
      await real(evs); // já foi para a fila...
      if (!crashed) {
        crashed = true;
        throw new Error('processo morreu antes do COMMIT'); // ...mas o published_at não foi gravado
      }
    };
    await expect(relayOnce({ db: t.relay.db, publish: flaky, batchSize: 40 })).rejects.toThrow();
    expect(await pending()).toBe(40);

    await relayOnce({ db: t.relay.db, publish: flaky, batchSize: 40 }); // "reinício": republica os mesmos 40
    expect(await pending()).toBe(0);
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'completed');
    expect(counts.waiting).toBe(40); // jobId = event_id: 40, não 80
    await queue.close();
  });

  it('ponta a ponta: cada evento chega UMA vez ao handler e ao pub/sub do tenant', async () => {
    await seed(25);
    const conn = bullConnection(redis);
    const queue = createEventsQueue(conn);
    const dlq = createDeadLetterQueue(conn);
    const handled: string[] = [];
    const worker = startEventsWorker({
      connection: conn,
      deadLetter: dlq,
      handlers: { 'member.removed': (e) => Promise.resolve(void handled.push(e.event_id)) },
    });
    const sub = new Redis({ host: valkey.getHost(), port: valkey.getMappedPort(6379) });
    const pubsub: EventEnvelope[] = [];
    await sub.subscribe(eventsChannel(A));
    sub.on('message', (_c, msg) => pubsub.push(JSON.parse(msg) as EventEnvelope));

    const loop = startRelay({
      db: t.relay.db,
      publish: createPublisher(queue, redis),
      intervalMs: 50,
    });
    await until(() => Promise.resolve(handled.length === 25 && pubsub.length === 25));
    await loop.stop();
    expect(new Set(handled).size).toBe(25);
    expect(new Set(pubsub.map((e) => e.event_id)).size).toBe(25);
    expect(pubsub.every((e) => e.account_id === A)).toBe(true);

    await worker.close();
    await queue.close();
    await dlq.close();
    sub.disconnect();
  });

  it('handler que sempre falha: tentativas esgotadas -> dead-letter queue com o motivo', async () => {
    await seed(2);
    const conn = bullConnection(redis);
    const queue = createEventsQueue(conn, { attempts: 3, backoffMs: 30 });
    const dlq = createDeadLetterQueue(conn);
    let attempts = 0;
    const worker = startEventsWorker({
      connection: conn,
      deadLetter: dlq,
      handlers: {
        'member.removed': () => {
          attempts++;
          return Promise.reject(new Error('serviço externo indisponível'));
        },
      },
    });
    await relayOnce({ db: t.relay.db, publish: createPublisher(queue, redis) });
    await until(async () => (await dlq.getJobCounts('waiting')).waiting === 2);
    expect(attempts).toBe(6); // 2 eventos x 3 tentativas
    const [job] = await dlq.getJobs(['waiting']);
    expect(job?.data).toMatchObject({ reason: 'serviço externo indisponível', attempts: 3 });
    await worker.close();
    await queue.close();
    await dlq.close();
  });
});

describe('trace no relay', () => {
  it('o envelope carrega o traceparent gravado no outbox', async () => {
    const tp = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await t.owner.db.insert(schema.outbox).values({
      accountId: A,
      aggregateType: 'test',
      aggregateId: uuidv7(),
      eventType: 'member.removed',
      payload: { user_id: uuidv7() },
      traceContext: tp,
    });
    const seen: EventEnvelope[] = [];
    await relayOnce({ db: t.relay.db, publish: (e) => Promise.resolve(void seen.push(...e)) });
    expect(seen[0]?.trace_context).toBe(tp);
  });
});

describe('laço do relay', () => {
  it('erro transitório não derruba o laço: tenta de novo e conclui; stop() é limpo', async () => {
    await seed(5);
    let calls = 0;
    const errors: unknown[] = [];
    const seen: string[] = [];
    const loop = startRelay({
      db: t.relay.db,
      intervalMs: 20,
      publish: (evs) => {
        if (++calls <= 2) return Promise.reject(new Error('instável'));
        seen.push(...evs.map((e) => e.event_id));
        return Promise.resolve();
      },
      onError: (e) => errors.push(e),
    });
    await until(async () => (await pending()) === 0);
    await loop.stop();
    expect(errors).toHaveLength(2);
    expect(seen).toHaveLength(5);

    await seed(1);
    await sleep(200);
    expect(await pending()).toBe(1); // depois do stop nada mais é publicado
  });
});

describe('NOTIFY do outbox', () => {
  it('um evento novo acorda o relay na hora, sem esperar o intervalo de polling', async () => {
    const published: EventEnvelope[] = [];
    const loop = startRelay({
      db: t.relay.db,
      publish: (events) => {
        published.push(...events);
        return Promise.resolve();
      },
      intervalMs: 60_000, // sem o NOTIFY só publicaria daqui a um minuto
    });
    const stop = listenOutbox(t.urls.relay, () => {
      loop.nudge();
    });
    await sleep(500); // dá tempo do LISTEN estar ativo
    const started = Date.now();
    await seed(1);
    await until(() => Promise.resolve(published.length === 1), 5000);
    expect(Date.now() - started).toBeLessThan(2000);
    await stop();
    await loop.stop();
  });

  it('nudge durante um ciclo em andamento não se perde (o próximo ciclo começa sem pausa)', async () => {
    const published: EventEnvelope[] = [];
    let release: () => void = () => undefined;
    let first = true;
    const loop = startRelay({
      db: t.relay.db,
      publish: async (events) => {
        if (first) {
          first = false;
          await new Promise<void>((r) => {
            release = r; // segura o primeiro ciclo enquanto chega um evento novo
          });
        }
        published.push(...events);
      },
      intervalMs: 60_000,
    });
    await seed(1);
    loop.nudge();
    await until(() => Promise.resolve(!first));
    await seed(1);
    loop.nudge(); // chega com o ciclo ocupado
    release();
    await until(() => Promise.resolve(published.length === 2), 5000);
    await loop.stop();
  });
});
