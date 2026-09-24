import { randomBytes, randomUUID } from 'node:crypto';
import {
  authenticate,
  createCtx,
  createInbox,
  login,
  registerAccount,
  sendMessage,
  type Ctx,
} from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { loadEnv, type EventEnvelope } from '@waychat/shared';
import { listenOutbox } from '@waychat/worker/notify';
import { bullConnection, createEventsQueue, createPublisher } from '@waychat/worker/queues';
import { startRelay, type RelayLoop } from '@waychat/worker/relay';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { io as connectClient, type Socket } from 'socket.io-client';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createRedisFeed } from './realtime.js';

/**
 * Aceite da Fase 1 com a cadeia REAL: Postgres (outbox + NOTIFY) → relay → BullMQ/Valkey → gateway WebSocket → cliente.
 * Só o navegador é simulado (sockets e HTTP de verdade contra o servidor).
 */
const PANEL = 'http://localhost:5173';
const SITE = 'https://loja.example.com';
const PASSWORD = 'uma-senha-bem-longa-42';
const SAMPLES = 40;
const BUDGET_P95_MS = 500;

let t: TestDb;
let valkey: StartedTestContainer;
let redis: Redis;
let ctx: Ctx;
let app: FastifyInstance;
let port: number;
let relay: RelayLoop;
let stopListening: () => Promise<void>;
const sockets: Socket[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const p95 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? Infinity;

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
  const env = loadEnv({
    PUBLIC_URL: PANEL,
    DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
    VALKEY_URL: 'redis://127.0.0.1:1',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'x',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
    MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: 'q'.repeat(48),
  });
  ctx = createCtx(t.app.db, {
    sessionSecret: env.SESSION_SECRET,
    masterKey: env.MASTER_KEY,
    masterKeyPrevious: [],
    accessTtlSeconds: 600,
    refreshTtlSeconds: 30 * 86400,
    challengeTtlSeconds: 300,
    issuer: 'WayChat',
  });
  const built = await buildApp({
    env,
    ctx,
    logger: false,
    realtime: { feed: createRedisFeed(redis), revalidateEveryMs: 3_600_000 },
  });
  app = built.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;

  // o worker de verdade: relay com NOTIFY + publicação na fila e no pub/sub
  const queue = createEventsQueue(bullConnection(redis));
  relay = startRelay({ db: t.relay.db, publish: createPublisher(queue, redis), intervalMs: 2000 });
  stopListening = listenOutbox(t.urls.relay, () => {
    relay.nudge();
  });
  await sleep(500);
}, 120_000);

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await stopListening();
  await relay.stop();
  await app.close();
  redis.disconnect();
  await valkey.stop();
  await t.stop();
});

async function scenario() {
  const email = `dono-${randomBytes(3).toString('hex')}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Loja',
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  const owner = await authenticate(ctx, r.tokens.accessToken);
  const { inbox } = await createInbox(ctx, owner, {
    name: 'Site',
    channelType: 'widget',
    allowedOrigins: [SITE],
  });
  const session = await app.inject({
    method: 'POST',
    url: '/widget/v1/session',
    headers: { origin: SITE },
    payload: { public_key: inbox.publicKey },
    remoteAddress: '10.9.0.1',
  });
  const token = session.json().token as string;

  const panel = connectClient(`http://127.0.0.1:${String(port)}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { cookie: `wc_at=${r.tokens.accessToken}`, origin: PANEL },
  });
  const visitor = connectClient(`http://127.0.0.1:${String(port)}/widget`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
    extraHeaders: { origin: SITE },
  });
  sockets.push(panel, visitor);
  await Promise.all([
    new Promise<void>((res, rej) => {
      panel.once('ready', () => {
        res();
      });
      panel.once('connect_error', rej);
    }),
    new Promise<void>((res, rej) => {
      visitor.once('ready', () => {
        res();
      });
      visitor.once('connect_error', rej);
    }),
  ]);
  return { accountId, owner, token, panel, visitor };
}

describe('aceite: latência de ponta a ponta', () => {
  it(`visitante → painel: p95 abaixo de ${String(BUDGET_P95_MS)} ms (cadeia real)`, async () => {
    const s = await scenario();
    const seen = new Map<string, number>();
    const waiters = new Map<string, () => void>();
    s.panel.on('event', (e: EventEnvelope) => {
      if (e.type !== 'message.created') return;
      const id = (e.payload as { message_id: string }).message_id;
      seen.set(id, performance.now());
      waiters.get(id)?.();
    });
    const lat: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: '/widget/v1/messages',
        headers: { authorization: `Bearer ${s.token}`, origin: SITE },
        payload: { content: `mensagem ${String(i)}`, client_message_id: randomUUID() },
        remoteAddress: `10.9.1.${String(i + 1)}`,
      });
      const id = res.json().message.id as string;
      if (!seen.has(id)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('evento não chegou ao painel'));
          }, 5000);
          waiters.set(id, () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      lat.push((seen.get(id) ?? performance.now()) - t0);
      await sleep(15);
    }
    const p = p95(lat);
    process.stdout.write(
      `\nvisitante → painel: p50=${[...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)]?.toFixed(0) ?? '?'} ms  p95=${p.toFixed(0)} ms  max=${Math.max(...lat).toFixed(0)} ms\n`,
    );
    expect(p).toBeLessThan(BUDGET_P95_MS);
  }, 60_000);

  it(`atendente → visitante: p95 abaixo de ${String(BUDGET_P95_MS)} ms (cadeia real)`, async () => {
    const s = await scenario();
    // cria a conversa (primeira mensagem do visitante) e descobre o id
    await app.inject({
      method: 'POST',
      url: '/widget/v1/messages',
      headers: { authorization: `Bearer ${s.token}`, origin: SITE },
      payload: { content: 'oi', client_message_id: randomUUID() },
      remoteAddress: '10.9.2.1',
    });
    const conv = await t.owner.pool.query('select id from conversations where account_id = $1', [
      s.accountId,
    ]);
    const conversationId = (conv.rows[0] as { id: string }).id;

    const seen = new Map<string, number>();
    const waiters = new Map<string, () => void>();
    s.visitor.on('message', (m: { id: string }) => {
      seen.set(m.id, performance.now());
      waiters.get(m.id)?.();
    });
    const lat: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t0 = performance.now();
      const { message } = await sendMessage(ctx, s.owner, {
        conversationId,
        content: `resposta ${String(i)}`,
        clientMessageId: randomUUID(),
      });
      if (!seen.has(message.id)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('resposta não chegou ao visitante'));
          }, 5000);
          waiters.set(message.id, () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      lat.push((seen.get(message.id) ?? performance.now()) - t0);
      await sleep(15);
    }
    const p = p95(lat);
    process.stdout.write(
      `\natendente → visitante: p95=${p.toFixed(0)} ms  max=${Math.max(...lat).toFixed(0)} ms\n`,
    );
    expect(p).toBeLessThan(BUDGET_P95_MS);
  }, 60_000);
});

describe('aceite: reconexão do visitante', () => {
  it('respostas que chegaram com o socket fora do ar aparecem no histórico ao voltar', async () => {
    const s = await scenario();
    await app.inject({
      method: 'POST',
      url: '/widget/v1/messages',
      headers: { authorization: `Bearer ${s.token}`, origin: SITE },
      payload: { content: 'oi', client_message_id: randomUUID() },
      remoteAddress: '10.9.3.1',
    });
    const conv = await t.owner.pool.query('select id from conversations where account_id = $1', [
      s.accountId,
    ]);
    const conversationId = (conv.rows[0] as { id: string }).id;

    s.visitor.disconnect();
    await sleep(100);
    for (const c of ['primeira', 'segunda']) {
      await sendMessage(ctx, s.owner, {
        conversationId,
        content: `${c} resposta offline`,
        clientMessageId: randomUUID(),
      });
    }
    const history = await app.inject({
      method: 'GET',
      url: '/widget/v1/messages',
      headers: { authorization: `Bearer ${s.token}`, origin: SITE },
      remoteAddress: '10.9.3.2',
    });
    const texts = (history.json().items as { content: string }[]).map((m) => m.content);
    expect(texts).toEqual(['oi', 'primeira resposta offline', 'segunda resposta offline']);
  });
});
