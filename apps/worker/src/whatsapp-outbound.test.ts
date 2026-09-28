import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { InboundContent, NormalizedEvent, SendJob } from '@waychat/channels';
import { createSendQueue, enqueueSend } from '@waychat/channels';
import {
  authenticate,
  connectWhatsApp,
  coreConfigFromEnv,
  createCtx,
  loadWhatsAppTarget,
  login,
  processWhatsAppEvent,
  registerAccount,
  sendMessage,
  type Actor,
  type Ctx,
  type WhatsAppTarget,
} from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import type { EventEnvelope } from '@waychat/shared';
import type { ObjectStore } from '@waychat/storage';
import type { Job, Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bullConnection } from './queues.js';
import type { GraphEnv } from './whatsapp-inbound.js';
import { acquireSendSlot } from './whatsapp-rate-limit.js';
import {
  handleMessageCreated,
  processSendJob,
  startWhatsAppSendWorker,
} from './whatsapp-outbound.js';

let t: TestDb;
let valkey: StartedTestContainer;
let redis: Redis;
let ctx: Ctx;
let sendQueue: Queue<SendJob>;

const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const GRAPH_ENV: GraphEnv = { version: 'v23.0', baseUrl: 'https://graph.test' };

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
  sendQueue = createSendQueue(bullConnection(redis));
  const cfg = coreConfigFromEnv({
    SESSION_SECRET: 'p'.repeat(48),
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_PREVIOUS: undefined,
  });
  ctx = createCtx(t.app.db, cfg, undefined, {
    store: new MemStore(),
    scanner: null,
    enqueueScan: () => Promise.resolve(),
  });
}, 120_000);

afterAll(async () => {
  await sendQueue.close();
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
    phoneNumberId: String(700000000000000 + n),
    wabaId: String(800000000000000 + n),
    accessToken: 'x'.repeat(30),
    appSecret: 'y'.repeat(20),
  });
  const target = await loadWhatsAppTarget(ctx, accountId, inbox.id);
  if (!target) throw new Error('esperava encontrar o alvo');
  return { accountId, owner, inbox, target };
}

async function conversationOf(target: WhatsAppTarget) {
  const providerId = `wamid.${uniq()}`;
  const content: InboundContent = { type: 'text', body: 'oi' };
  const event: Extract<NormalizedEvent, { kind: 'message' }> = {
    kind: 'message',
    providerId,
    accountRef: target.config.phoneNumberId,
    from: { id: 'wa-5511988887777' },
    at: new Date('2026-01-15T12:00:00.000Z'),
    content,
  };
  await processWhatsAppEvent(ctx, target, event);
  const row = await t.owner.pool.query(
    `select conversation_id from messages where source_id = $1 and inbox_id = $2`,
    [providerId, target.inboxId],
  );
  return (row.rows[0] as { conversation_id: string }).conversation_id;
}

const fakeJob = (data: SendJob, timestamp = Date.now()) => ({ data, timestamp }) as Job<SendJob>;

const okSend = (id = 'wamid.OUT1') =>
  ((url: string) => {
    if (url.endsWith('/messages'))
      return Promise.resolve(new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 }));
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;

describe('handleMessageCreated: filtra e enfileira', () => {
  it('mensagem de saída de uma inbox WhatsApp: enfileira', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    const event: EventEnvelope = {
      event_id: crypto.randomUUID(),
      cursor: 1,
      account_id: s.accountId,
      type: 'message.created',
      occurred_at: new Date().toISOString(),
      payload: {
        message_id: sent.message.id,
        conversation_id: conv,
        inbox_id: s.inbox.id,
        private: false,
        direction: 'out',
      },
    };
    await handleMessageCreated(ctx, sendQueue)(event);
    expect(await sendQueue.getJob(`send-${sent.message.id}`)).toBeDefined();
  });

  it('entrada, nota interna, ou inbox que não é WhatsApp: não enfileira', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const base = { conversation_id: conv, inbox_id: s.inbox.id };
    const envelope = (messageId: string, payload: Record<string, unknown>): EventEnvelope => ({
      event_id: crypto.randomUUID(),
      cursor: 1,
      account_id: s.accountId,
      type: 'message.created',
      occurred_at: new Date().toISOString(),
      payload: { message_id: messageId, ...base, ...payload },
    });
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    await handleMessageCreated(
      ctx,
      sendQueue,
    )(envelope(ids[0]!, { private: false, direction: 'in' }));
    await handleMessageCreated(
      ctx,
      sendQueue,
    )(envelope(ids[1]!, { private: true, direction: 'out' }));
    await handleMessageCreated(
      ctx,
      sendQueue,
    )(envelope(ids[2]!, { private: false, direction: 'out', inbox_id: crypto.randomUUID() }));
    for (const id of ids) expect(await sendQueue.getJob(`send-${id}`)).toBeUndefined();
  });
});

describe('processSendJob: envio direto (chamado sem passar pela fila)', () => {
  it('texto: sucesso grava o wamid e "sent"; o corpo leva o id da mensagem em biz_opaque_callback_data', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'Olá!',
      clientMessageId: crypto.randomUUID(),
    });
    let capturedBody: Record<string, unknown> | undefined;
    const fetchSpy = ((url: string, init?: RequestInit) => {
      if (init?.body) capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return okSend('wamid.TXT1')(url);
    }) as typeof fetch;
    await processSendJob(
      ctx,
      redis,
      { ...GRAPH_ENV, fetch: fetchSpy },
      fakeJob({ accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id }),
    );
    const row = await t.owner.pool.query('select status, source_id from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sent', source_id: 'wamid.TXT1' });
    expect(capturedBody).toMatchObject({
      biz_opaque_callback_data: sent.message.id,
      to: 'wa-5511988887777',
      type: 'text',
    });
  });

  it('erro não repetível (janela fechada): marca "failed" com o código e a mensagem em português', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    const failFetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 131047, message: 'x' } }), { status: 400 }),
      )) as typeof fetch;
    await processSendJob(
      ctx,
      redis,
      { ...GRAPH_ENV, fetch: failFetch },
      fakeJob({ accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id }),
    );
    const row = await t.owner.pool.query('select status, error_code from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'failed', error_code: 'window_closed' });
  });

  it('erro ambíguo/transitório (timeout de rede): a exceção sobe, e a mensagem fica "sending" para a próxima tentativa decidir', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    const brokenFetch = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    await expect(
      processSendJob(
        ctx,
        redis,
        { ...GRAPH_ENV, fetch: brokenFetch },
        fakeJob({ accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id }),
      ),
    ).rejects.toThrow();
    const row = await t.owner.pool.query('select status, source_id from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sending', source_id: null });
  });

  it('reconciliação: chamado de novo ainda dentro da janela de 2 min, lança e NÃO tenta enviar de novo', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    let calls = 0;
    const countingFetch = ((url: string) => {
      calls++;
      return okSend('wamid.NUNCA')(url);
    }) as typeof fetch;
    // primeira tentativa "trava" (nunca resolve o envio: simula processo derrubado no meio, deixando "sending" sem wamid)
    await t.owner.pool.query("update messages set status = 'sending', attempts = 1 where id = $1", [
      sent.message.id,
    ]);
    const job = fakeJob(
      { accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id },
      Date.now(),
    ); // job "novo": ainda dentro da janela
    await expect(
      processSendJob(ctx, redis, { ...GRAPH_ENV, fetch: countingFetch }, job),
    ).rejects.toThrow();
    expect(calls).toBe(0); // não chegou a chamar a Graph API
  });

  it('reconciliação: fora da janela de 2 min, tenta de novo (e conclui)', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query("update messages set status = 'sending', attempts = 1 where id = $1", [
      sent.message.id,
    ]);
    const job = fakeJob(
      { accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id },
      Date.now() - 130_000,
    );
    await processSendJob(ctx, redis, { ...GRAPH_ENV, fetch: okSend('wamid.RETRY1') }, job);
    const row = await t.owner.pool.query(
      'select status, source_id, attempts from messages where id = $1',
      [sent.message.id],
    );
    expect(row.rows[0]).toEqual({ status: 'sent', source_id: 'wamid.RETRY1', attempts: 2 });
  });

  it('mensagem já resolvida por um webhook de status enquanto o job esperava: não reenvia', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query(
      "update messages set status = 'sending', source_id = 'wamid.JAVEIO' where id = $1",
      [sent.message.id],
    );
    let calls = 0;
    const countingFetch = ((url: string) => {
      calls++;
      return okSend()(url);
    }) as typeof fetch;
    const job = fakeJob(
      { accountId: s.accountId, inboxId: s.inbox.id, messageId: sent.message.id },
      Date.now() - 130_000,
    );
    await processSendJob(ctx, redis, { ...GRAPH_ENV, fetch: countingFetch }, job);
    expect(calls).toBe(0);
    const row = await t.owner.pool.query('select status, source_id from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sent', source_id: 'wamid.JAVEIO' });
  });
});

describe('fila de verdade: da fila até o status gravado', () => {
  it('startWhatsAppSendWorker processa um job real da fila', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv,
      content: 'Via fila',
      clientMessageId: crypto.randomUUID(),
    });
    const graphEnv: GraphEnv = { ...GRAPH_ENV, fetch: okSend('wamid.QUEUE1') };
    const worker = startWhatsAppSendWorker(bullConnection(redis), ctx, redis, graphEnv);
    try {
      await enqueueSend(sendQueue, {
        accountId: s.accountId,
        inboxId: s.inbox.id,
        messageId: sent.message.id,
      });
      await until(async () => {
        const r = await t.owner.pool.query(
          "select status from messages where id = $1 and status = 'sent'",
          [sent.message.id],
        );
        return r.rows.length === 1;
      });
    } finally {
      await worker.close();
    }
  });
});

describe('acquireSendSlot: limitador de taxa por número', () => {
  it('respeita o limite por segundo: a chamada extra espera até a próxima janela', async () => {
    const inboxId = `rl-${uniq()}`;
    const start = Date.now();
    await acquireSendSlot(redis, inboxId, 2, 3000);
    await acquireSendSlot(redis, inboxId, 2, 3000);
    const third = acquireSendSlot(redis, inboxId, 2, 3000); // estoura o limite de 2/s
    await third;
    expect(Date.now() - start).toBeGreaterThanOrEqual(150); // teve que esperar pelo menos um pouco
  });

  it('inboxes diferentes têm janelas independentes', async () => {
    const before = Date.now();
    await acquireSendSlot(redis, `a-${uniq()}`, 1, 1000);
    await acquireSendSlot(redis, `b-${uniq()}`, 1, 1000);
    expect(Date.now() - before).toBeLessThan(300); // não competiu pela mesma janela
  });
});
