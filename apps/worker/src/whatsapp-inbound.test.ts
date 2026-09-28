import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { InboundContent, NormalizedEvent } from '@waychat/channels';
import { createInboundQueue, enqueueInbound, type InboundJob } from '@waychat/channels';
import {
  acceptWhatsAppEvents,
  authenticate,
  connectWhatsApp,
  coreConfigFromEnv,
  createCtx,
  loadWhatsAppTarget,
  login,
  registerAccount,
  type Actor,
  type Ctx,
  type WhatsAppTarget,
} from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import type { ObjectStore } from '@waychat/storage';
import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bullConnection } from './queues.js';
import {
  processInboundJob,
  startWhatsAppInboundWorker,
  type GraphEnv,
} from './whatsapp-inbound.js';

let t: TestDb;
let valkey: StartedTestContainer;
let redis: Redis;
let ctx: Ctx;
let worker: Worker<InboundJob>;

const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Compartilhado por todos os testes; a URL falsa faz o `fetch` global falhar sozinho quando não é sobrescrita. */
const GRAPH_ENV: GraphEnv = { version: 'v23.0', baseUrl: 'https://graph.test' };

/** Armazenamento em memória: a mídia "baixada da Meta" já chega em bytes. */
class MemStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  presignUpload(key: string) {
    return Promise.resolve({ url: 'http://s3.test/bucket', fields: { key } });
  }
  put(key: string, body: Buffer) {
    this.objects.set(key, new Uint8Array(body));
    return Promise.resolve();
  }
  head(key: string) {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.length } : null);
  }
  readHead(key: string, bytes: number) {
    return Promise.resolve((this.objects.get(key) ?? new Uint8Array()).subarray(0, bytes));
  }
  stream(key: string) {
    return Promise.resolve(Readable.from([Buffer.from(this.objects.get(key) ?? [])]));
  }
  remove(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  presignDownload(key: string) {
    return Promise.resolve(`http://s3.test/${key}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
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
  const connection = bullConnection(redis);
  const queue = createInboundQueue(connection);
  const cfg = coreConfigFromEnv({
    SESSION_SECRET: 'z'.repeat(48),
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_PREVIOUS: undefined,
  });
  ctx = createCtx(
    t.app.db,
    cfg,
    undefined,
    { store: new MemStore(), scanner: null, enqueueScan: () => Promise.resolve() },
    {
      enqueueInbound: (job) => enqueueInbound(queue, job),
    },
  );
  worker = startWhatsAppInboundWorker(connection, ctx, GRAPH_ENV);
}, 120_000);

afterAll(async () => {
  await worker.close();
  redis.disconnect();
  await valkey.stop();
  await t.stop();
});

async function setup() {
  const email = `dono-${uniq()}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Loja',
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  const owner: Actor = await authenticate(ctx, r.tokens.accessToken);
  const { inbox } = await connectWhatsApp(ctx, owner, {
    name: `WhatsApp ${uniq()}`,
    phoneNumberId: String(300000000000000 + n),
    wabaId: String(400000000000000 + n),
    accessToken: 'x'.repeat(30),
    appSecret: 'y'.repeat(20),
  });
  const target = await loadWhatsAppTarget(ctx, accountId, inbox.id);
  if (!target) throw new Error('esperava encontrar o alvo');
  return { accountId, owner, inbox, target };
}

const msg = (
  target: WhatsAppTarget,
  providerId: string,
  content: InboundContent,
): Extract<NormalizedEvent, { kind: 'message' }> => ({
  kind: 'message',
  providerId,
  accountRef: target.config.phoneNumberId,
  from: { id: 'wa-5511988887777' },
  at: new Date('2026-01-15T12:00:00.000Z'),
  content,
});

describe('processamento do webhook do WhatsApp (fila real)', () => {
  it('texto: da fila até a mensagem gravada e o evento de entrada marcado como processado', async () => {
    const s = await setup();
    await acceptWhatsAppEvents(ctx, s.target, [
      msg(s.target, 'wamid.W1', { type: 'text', body: 'Olá' }),
    ]);

    await until(async () => {
      const r = await t.owner.pool.query(
        `select count(*)::int as n from messages where source_id = 'wamid.W1'`,
      );
      return (r.rows[0] as { n: number }).n === 1;
    });
    const ev = await t.owner.pool.query(
      `select status from inbound_events where inbox_id = $1 and external_id = 'msg:wamid.W1'`,
      [s.inbox.id],
    );
    expect(ev.rows[0]).toEqual({ status: 'processed' });
  });

  it('mensagem com mídia baixa da Graph API antes de gravar, e vira anexo "clean"', async () => {
    const s = await setup();
    // a Graph API sempre é chamada com a URL em string (nunca URL/Request): simplifica o dublê.
    GRAPH_ENV.fetch = ((url: string) => {
      if (url.startsWith('https://graph.test/'))
        return Promise.resolve(
          new Response(
            JSON.stringify({ url: 'https://lookaside.test/media/9001', mime_type: 'image/png' }),
            {
              status: 200,
            },
          ),
        );
      if (url === 'https://lookaside.test/media/9001')
        return Promise.resolve(new Response(PNG, { status: 200 }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    }) as typeof fetch;
    try {
      await acceptWhatsAppEvents(ctx, s.target, [
        msg(s.target, 'wamid.IMGQ1', {
          type: 'image',
          media: { id: '9001', mimeType: 'image/png' },
          caption: 'Comprovante',
        }),
      ]);
      await until(async () => {
        const r = await t.owner.pool.query(
          `select count(*)::int as n from attachments a join messages m on m.id = a.message_id
           where m.source_id = 'wamid.IMGQ1' and a.status = 'clean'`,
        );
        return (r.rows[0] as { n: number }).n === 1;
      });
    } finally {
      delete GRAPH_ENV.fetch;
    }
  });

  it('job repetido (mesmo evento processado de novo) é um no-op: não duplica nem lança', async () => {
    const s = await setup();
    await acceptWhatsAppEvents(ctx, s.target, [
      msg(s.target, 'wamid.W2', { type: 'text', body: 'oi' }),
    ]);
    await until(async () => {
      const r = await t.owner.pool.query(
        `select count(*)::int as n from messages where source_id = 'wamid.W2'`,
      );
      return (r.rows[0] as { n: number }).n === 1;
    });
    const row = await t.owner.pool.query(
      `select id from inbound_events where inbox_id = $1 and external_id = 'msg:wamid.W2'`,
      [s.inbox.id],
    );
    const job: InboundJob = {
      accountId: s.accountId,
      inboxId: s.inbox.id,
      eventId: (row.rows[0] as { id: string }).id,
    };
    await processInboundJob(ctx, GRAPH_ENV, job); // já está "processed": não deve reprocessar
    const count = await t.owner.pool.query(
      `select count(*)::int as n from messages where source_id = 'wamid.W2'`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('falha ao baixar a mídia: a exceção sobe e o evento fica "received" para o BullMQ tentar de novo', async () => {
    const s = await setup();
    const event = msg(s.target, 'wamid.FAIL1', {
      type: 'image',
      media: { id: '9099', mimeType: 'image/png' },
    });
    // insere direto (sem passar pela fila real): evita que o worker compartilhado tente com a URL falsa em segundo plano
    const row = await t.owner.pool.query(
      `insert into inbound_events (id, account_id, inbox_id, external_id, payload)
       values (gen_random_uuid(), $1, $2, 'msg:wamid.FAIL1', $3) returning id`,
      [s.accountId, s.inbox.id, JSON.stringify(event)],
    );
    const eventId = (row.rows[0] as { id: string }).id;
    const failFetch = (() =>
      Promise.resolve(new Response('erro', { status: 500 }))) as typeof fetch;

    await expect(
      processInboundJob(
        ctx,
        { ...GRAPH_ENV, fetch: failFetch },
        { accountId: s.accountId, inboxId: s.inbox.id, eventId },
      ),
    ).rejects.toThrow();
    const after = await t.owner.pool.query('select status from inbound_events where id = $1', [
      eventId,
    ]);
    expect((after.rows[0] as { status: string }).status).toBe('received');
  });

  it('inbox removida/trocada de canal entre o webhook e o processamento: não lança, apenas não processa', async () => {
    const s = await setup();
    const event = msg(s.target, 'wamid.GONE1', { type: 'text', body: 'x' });
    const row = await t.owner.pool.query(
      `insert into inbound_events (id, account_id, inbox_id, external_id, payload)
       values (gen_random_uuid(), $1, $2, 'msg:wamid.GONE1', $3) returning id`,
      [s.accountId, s.inbox.id, JSON.stringify(event)],
    );
    const eventId = (row.rows[0] as { id: string }).id;
    await t.owner.pool.query(`delete from inboxes where id = $1`, [s.inbox.id]);
    await expect(
      processInboundJob(ctx, GRAPH_ENV, { accountId: s.accountId, inboxId: s.inbox.id, eventId }),
    ).resolves.toBeUndefined();
  });
});
