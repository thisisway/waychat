import { randomBytes } from 'node:crypto';
import {
  addMember,
  authenticate,
  changeMemberRole,
  createCtx,
  createInbox,
  listRoles,
  login,
  logout,
  receiveInboundMessage,
  registerAccount,
  removeMember,
  sendMessage,
  setInboxMembers,
  type AuthenticatedActor,
  type Ctx,
} from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { eventEnvelopeSchema, loadEnv, uuidv7, type EventEnvelope } from '@waychat/shared';
import { Redis } from 'ioredis';
import { io as connectClient, type Socket } from 'socket.io-client';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { createRedisFeed, EVENTS_PATTERN, type EventFeed, type Realtime } from './realtime.js';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
let ctx: Ctx;
let rt: Realtime;
let port: number;
let close: () => Promise<void>;

/** Fonte de eventos controlada pelo teste: `pump()` faz o papel do relay do outbox. */
const listeners: ((e: EventEnvelope) => void)[] = [];
const feed: EventFeed = {
  start: (cb) => {
    listeners.push(cb);
    return Promise.resolve();
  },
  stop: () => Promise.resolve(),
};
const pumped = new Map<string, number>(); // account_id -> último account_seq já publicado

async function pump(accountId: string): Promise<void> {
  const rows = await t.owner.pool.query(
    'select * from outbox where account_id = $1 and account_seq > $2 order by account_seq',
    [accountId, pumped.get(accountId) ?? 0],
  );
  for (const r of rows.rows as Record<string, unknown>[]) {
    const env = eventEnvelopeSchema.parse({
      event_id: r['id'],
      cursor: Number(r['account_seq']),
      account_id: r['account_id'],
      type: r['event_type'],
      occurred_at: (r['created_at'] as Date).toISOString(),
      payload: r['payload'],
    });
    pumped.set(accountId, env.cursor);
    for (const l of listeners) l(env);
  }
}

interface Session {
  cookie: string;
  actor: AuthenticatedActor;
  userId: string;
}

/** Uma sessão real: o cookie que o navegador enviaria e o ator dessa MESMA sessão (mesma família de refresh). */
async function sessionFor(email: string): Promise<{ cookie: string; actor: AuthenticatedActor }> {
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  return {
    cookie: `wc_at=${r.tokens.accessToken}`,
    actor: await authenticate(ctx, r.tokens.accessToken),
  };
}

async function actorOf(email: string): Promise<AuthenticatedActor> {
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  return authenticate(ctx, r.tokens.accessToken);
}

async function team() {
  const ownerEmail = `dono-${uniq()}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Acme',
    ownerName: 'Dono',
    email: ownerEmail,
    password: PASSWORD,
  });
  const owner = await actorOf(ownerEmail);
  const roles = await listRoles(ctx, owner);
  const agentRole = roles.find((r) => r.name === 'Agente')?.id ?? '';
  const mk = async (name: string): Promise<Session> => {
    const email = `${name}-${uniq()}@exemplo.com`;
    const { userId } = await addMember(ctx, owner, {
      email,
      name,
      password: PASSWORD,
      roleId: agentRole,
    });
    return { ...(await sessionFor(email)), userId };
  };
  const a = await mk('agentea');
  const b = await mk('agenteb');
  const in1 = (await createInbox(ctx, owner, { name: 'Vendas', channelType: 'widget' })).inbox;
  const in2 = (await createInbox(ctx, owner, { name: 'Suporte', channelType: 'widget' })).inbox;
  await setInboxMembers(ctx, owner, in1.id, [a.userId]);
  await setInboxMembers(ctx, owner, in2.id, [b.userId]);
  const ownerSession: Session = { ...(await sessionFor(ownerEmail)), userId: owner.userId };
  await pump(accountId); // descarta o histórico de preparação: os testes só olham o que vem depois
  return { accountId, owner: ownerSession, a, b, in1, in2 };
}

const inbound = (accountId: string, inboxId: string, who: string, content: string) =>
  receiveInboundMessage(ctx, {
    accountId,
    inboxId,
    identity: { channel: 'widget', externalId: who, name: `Visitante ${who}` },
    content,
  });

interface Client {
  socket: Socket;
  events: EventEnvelope[];
  other: Record<string, unknown[]>;
  ready: Promise<{ cursor: number; online: string[] }>;
}

const opened: Socket[] = [];
function connect(cookie: string, origin: string | null = ORIGIN): Client {
  const socket = connectClient(`http://127.0.0.1:${String(port)}`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: { cookie, ...(origin ? { origin } : {}) },
  });
  opened.push(socket);
  const events: EventEnvelope[] = [];
  const other: Record<string, unknown[]> = {};
  socket.on('event', (e: EventEnvelope) => events.push(e));
  for (const name of ['presence.updated', 'viewer.joined', 'viewer.left', 'typing']) {
    socket.on(name, (p: unknown) => (other[name] ??= []).push(p));
  }
  const ready = new Promise<{ cursor: number; online: string[] }>((resolve, reject) => {
    socket.once('ready', resolve);
    socket.once('connect_error', reject);
  });
  return { socket, events, other, ready };
}

const types = (c: Client) => c.events.map((e) => e.type);
const rejectsToConnect = async (c: Client) => {
  await expect(c.ready).rejects.toBeDefined();
  expect(c.socket.connected).toBe(false);
};
const emitAck = <T>(s: Socket, event: string, payload: unknown) =>
  new Promise<T>((resolve) => {
    s.emit(event, payload, resolve);
  });

beforeAll(async () => {
  t = await startTestDb();
  const env = loadEnv({
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
    VALKEY_URL: 'redis://127.0.0.1:1',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'x',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
    MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: 'r'.repeat(48),
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
    realtime: { feed, revalidateEveryMs: 3_600_000 },
  });
  if (!built.realtime) throw new Error('tempo real não foi ligado');
  rt = built.realtime;
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  port = (built.app.server.address() as { port: number }).port;
  close = () => built.app.close();
});

afterAll(async () => {
  for (const s of opened) s.disconnect();
  await close();
  await t.stop();
});

describe('conexão e autenticação', () => {
  it('sem cookie, com cookie inválido ou de origem errada a conexão é recusada', async () => {
    const { a } = await team();
    await rejectsToConnect(connect(''));
    await rejectsToConnect(connect('wc_at=lixo'));
    // cookie VÁLIDO, mas o handshake vem de outro site: é o sequestro de WebSocket entre sites (CSWSH)
    await rejectsToConnect(connect(a.cookie, 'https://evil.example'));
    const ok = connect(a.cookie);
    await ok.ready;
    expect(ok.socket.connected).toBe(true);
  });

  it('o "ready" traz o cursor atual e quem está online', async () => {
    const { accountId, a, b } = await team();
    const first = connect(a.cookie);
    const r1 = await first.ready;
    expect(r1.cursor).toBe(pumped.get(accountId));
    expect(r1.online).toContain(a.userId);
    const second = connect(b.cookie);
    const r2 = await second.ready;
    expect(new Set(r2.online)).toEqual(new Set([a.userId, b.userId]));
    await sleep(100);
    expect(first.other['presence.updated']).toContainEqual({ user_id: b.userId, status: 'online' });
  });

  it('presença: sair da última conexão avisa "offline"', async () => {
    const { a, b } = await team();
    const watcher = connect(a.cookie);
    await watcher.ready;
    const c = connect(b.cookie);
    await c.ready;
    c.socket.disconnect();
    await sleep(300);
    expect(watcher.other['presence.updated']).toContainEqual({
      user_id: b.userId,
      status: 'offline',
    });
  });

  it('no máximo 10 conexões simultâneas por usuário', async () => {
    const { a } = await team();
    const cs = Array.from({ length: 10 }, () => connect(a.cookie));
    await Promise.all(cs.map((c) => c.ready));
    await rejectsToConnect(connect(a.cookie));
    for (const c of cs) c.socket.disconnect();
  });
});

describe('entrega de eventos por visibilidade', () => {
  it('cada um recebe só o que pode ver (agente A: inbox 1; B: inbox 2; dono: tudo)', async () => {
    const { accountId, owner, a, b, in1, in2 } = await team();
    const [ca, cb, co] = [connect(a.cookie), connect(b.cookie), connect(owner.cookie)];
    await Promise.all([ca.ready, cb.ready, co.ready]);

    await inbound(accountId, in1.id, 'v1', 'na inbox 1');
    await inbound(accountId, in2.id, 'v2', 'na inbox 2');
    await pump(accountId);
    await sleep(300);

    expect(types(ca)).toEqual(['conversation.created', 'message.created']);
    expect(types(cb)).toEqual(['conversation.created', 'message.created']);
    expect(ca.events.every((e) => (e.payload as { inbox_id: string }).inbox_id === in1.id)).toBe(
      true,
    );
    expect(cb.events.every((e) => (e.payload as { inbox_id: string }).inbox_id === in2.id)).toBe(
      true,
    );
    expect(types(co)).toHaveLength(4);
    // o cursor chega contíguo e o conteúdo da mensagem nunca vai no evento
    expect(JSON.stringify(co.events)).not.toContain('na inbox');
  });

  it('nota interna chega à equipe da inbox (private=true) e a quem é de outra inbox, não', async () => {
    const { accountId, a, b, in1 } = await team();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    await pump(accountId);
    const [ca, cb] = [connect(a.cookie), connect(b.cookie)];
    await Promise.all([ca.ready, cb.ready]);
    await sendMessage(ctx, a.actor, {
      conversationId,
      content: 'nota',
      private: true,
      clientMessageId: uuidv7(),
    });
    await pump(accountId);
    await sleep(300);
    expect(ca.events.map((e) => (e.payload as { private?: boolean }).private)).toEqual([true]);
    expect(cb.events).toEqual([]);
  });

  it('entrar numa inbox passa a entregar seus eventos; sair para de entregar (visibilidade recalculada)', async () => {
    const { accountId, owner, a, in2 } = await team();
    const ca = connect(a.cookie);
    await ca.ready;
    await inbound(accountId, in2.id, 'v2', 'antes de entrar');
    await pump(accountId);
    await sleep(200);
    expect(ca.events).toEqual([]);

    await setInboxMembers(ctx, owner.actor, in2.id, [a.userId]); // emite inbox.updated
    await pump(accountId);
    await sleep(300);
    await inbound(accountId, in2.id, 'v3', 'depois de entrar');
    await pump(accountId);
    await sleep(300);
    const received = () => ca.events.filter((e) => e.type === 'message.created').length;
    expect(received()).toBe(1); // só a mensagem de DEPOIS de entrar; a de antes nunca chegou

    await setInboxMembers(ctx, owner.actor, in2.id, []);
    await pump(accountId);
    await sleep(300);
    await inbound(accountId, in2.id, 'v4', 'depois de sair');
    await pump(accountId);
    await sleep(300);
    expect(received()).toBe(1); // depois de sair, nada novo
  });

  it('remover o membro derruba a conexão dele; mudar o papel recalcula as permissões', async () => {
    const { accountId, owner, a, b } = await team();
    const ca = connect(a.cookie);
    const cb = connect(b.cookie);
    await Promise.all([ca.ready, cb.ready]);
    await removeMember(ctx, owner.actor, a.userId);
    await pump(accountId);
    await vi_waitFor(() => !ca.socket.connected);
    expect(cb.socket.connected).toBe(true);

    const roles = await listRoles(ctx, owner.actor);
    const supervisor = roles.find((r) => r.name === 'Supervisor')?.id ?? '';
    await changeMemberRole(ctx, owner.actor, b.userId, supervisor);
    await pump(accountId);
    await sleep(300);
    expect(cb.socket.connected).toBe(true); // continua conectado, agora como supervisor (vê todas as inboxes)
  });

  it('sessão revogada: a reavaliação derruba a conexão', async () => {
    const { a } = await team();
    const ca = connect(a.cookie);
    await ca.ready;
    await logout(ctx, a.actor);
    await rt.revalidateAll();
    await vi_waitFor(() => !ca.socket.connected);
  });

  it('isolamento entre contas: eventos de uma conta nunca chegam à outra', async () => {
    const one = await team();
    const two = await team();
    const [c1, c2] = [connect(one.owner.cookie), connect(two.owner.cookie)];
    await Promise.all([c1.ready, c2.ready]);
    await inbound(one.accountId, one.in1.id, 'v1', 'da conta um');
    await pump(one.accountId);
    await sleep(300);
    expect(types(c1)).toContain('message.created');
    expect(c2.events).toEqual([]);
  });
});

describe('salas de conversa: visualização e digitação', () => {
  it('só entra em sala de conversa que pode ver; "não existe" e "não pode ver" respondem igual', async () => {
    const { accountId, a, in1, in2 } = await team();
    const mine = await inbound(accountId, in1.id, 'v1', 'minha');
    const theirs = await inbound(accountId, in2.id, 'v2', 'de outra inbox');
    const ca = connect(a.cookie);
    await ca.ready;
    expect(
      await emitAck(ca.socket, 'join_conversation', { conversation_id: mine.conversationId }),
    ).toMatchObject({ ok: true });
    const denied = await emitAck(ca.socket, 'join_conversation', {
      conversation_id: theirs.conversationId,
    });
    const ghost = await emitAck(ca.socket, 'join_conversation', { conversation_id: uuidv7() });
    const junk = await emitAck(ca.socket, 'join_conversation', { conversation_id: 'nao-uuid' });
    expect(denied).toEqual({ ok: false });
    expect(ghost).toEqual(denied);
    expect(junk).toEqual(denied);
  });

  it('digitação e "quem está vendo": só para quem está na sala, nunca para o próprio remetente', async () => {
    const { accountId, owner, a, in1 } = await team();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    const [ca, co, outsider] = [
      connect(a.cookie),
      connect(owner.cookie),
      connect((await team()).owner.cookie),
    ];
    await Promise.all([ca.ready, co.ready, outsider.ready]);
    const payload = { conversation_id: conversationId };
    await emitAck(ca.socket, 'join_conversation', payload);
    const joinedOwner = await emitAck<{ ok: boolean; viewers: string[] }>(
      co.socket,
      'join_conversation',
      payload,
    );
    expect(joinedOwner.viewers).toEqual([a.userId]); // o dono vê que a agente já está na conversa
    await sleep(150);
    expect(ca.other['viewer.joined']).toEqual([
      { conversation_id: conversationId, user_id: owner.userId },
    ]);

    ca.socket.emit('typing', { ...payload, on: true });
    await sleep(200);
    expect(co.other['typing']).toEqual([
      { conversation_id: conversationId, user_id: a.userId, on: true },
    ]);
    expect(ca.other['typing']).toBeUndefined(); // não volta para quem digitou
    expect(outsider.other['typing']).toBeUndefined();

    outsider.socket.emit('typing', { ...payload, on: true }); // fora da sala: ignorado
    await sleep(150);
    expect(co.other['typing']).toHaveLength(1);

    co.socket.emit('leave_conversation', payload);
    await sleep(150);
    expect(ca.other['viewer.left']).toEqual([
      { conversation_id: conversationId, user_id: owner.userId },
    ]);
    ca.socket.disconnect();
    await sleep(150);
  });

  it('limite de taxa na digitação: rajada de 30 avisos entrega poucos', async () => {
    const { accountId, owner, a, in1 } = await team();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    const [ca, co] = [connect(a.cookie), connect(owner.cookie)];
    await Promise.all([ca.ready, co.ready]);
    const payload = { conversation_id: conversationId };
    await emitAck(ca.socket, 'join_conversation', payload);
    await emitAck(co.socket, 'join_conversation', payload);
    for (let i = 0; i < 30; i++) ca.socket.emit('typing', { ...payload, on: i % 2 === 0 });
    await sleep(400);
    expect((co.other['typing'] ?? []).length).toBeLessThanOrEqual(7);
    expect((co.other['typing'] ?? []).length).toBeGreaterThan(0);
  });
});

describe('recuperação após reconexão', () => {
  it('quem ficou offline pede /sync com o último cursor e recebe exatamente o que perdeu, sem repetir', async () => {
    const { accountId, owner, in1 } = await team();
    const live = connect(owner.cookie);
    const { cursor: startCursor } = await live.ready;
    await inbound(accountId, in1.id, 'v1', 'primeira');
    await pump(accountId);
    await sleep(250);
    const lastSeen = live.events.at(-1)?.cursor ?? startCursor;
    expect(lastSeen).toBeGreaterThan(startCursor);
    live.socket.disconnect();

    // enquanto está offline, acontecem coisas
    await inbound(accountId, in1.id, 'v2', 'segunda');
    await inbound(accountId, in1.id, 'v1', 'terceira');
    await pump(accountId);

    const res = await fetch(`http://127.0.0.1:${String(port)}/sync?since=${String(lastSeen)}`, {
      headers: { cookie: owner.cookie },
    });
    const body = (await res.json()) as {
      events: EventEnvelope[];
      cursor: number;
      has_more: boolean;
    };
    expect(body.events.map((e) => e.type)).toEqual([
      'conversation.created',
      'message.created',
      'message.created',
    ]);
    expect(body.events[0]?.cursor).toBe(lastSeen + 1);

    const back = connect(owner.cookie);
    const ready = await back.ready;
    expect(ready.cursor).toBe(body.cursor); // o cursor do "ready" coincide com o fim do /sync
    await inbound(accountId, in1.id, 'v2', 'quarta');
    await pump(accountId);
    await sleep(250);
    const all = new Map<string, EventEnvelope>();
    for (const e of [...live.events, ...body.events, ...back.events]) all.set(e.event_id, e);
    const cursors = [...all.values()].map((e) => e.cursor).sort((x, y) => x - y);
    expect(cursors).toEqual(cursors.map((_, i) => (cursors[0] ?? 0) + i)); // nada perdido, nada duplicado
  });
});

describe('fonte de eventos do Valkey', () => {
  let valkey: StartedTestContainer;
  let redis: Redis;

  beforeAll(async () => {
    valkey = await new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    redis = new Redis({
      host: valkey.getHost(),
      port: valkey.getMappedPort(6379),
      maxRetriesPerRequest: null,
    });
  });
  afterAll(async () => {
    redis.disconnect();
    await valkey.stop();
  });

  it('recebe o que o relay publica em wc:events:{conta}, valida o envelope e ignora lixo', async () => {
    expect(EVENTS_PATTERN).toBe('wc:events:*');
    const got: EventEnvelope[] = [];
    const rf = createRedisFeed(redis);
    await rf.start((e) => got.push(e));
    const valid: EventEnvelope = {
      event_id: uuidv7(),
      cursor: 7,
      account_id: uuidv7(),
      type: 'message.created',
      occurred_at: new Date().toISOString(),
      payload: { inbox_id: uuidv7() },
    };
    await redis.publish(`wc:events:${valid.account_id}`, 'isto não é json');
    await redis.publish(`wc:events:${valid.account_id}`, JSON.stringify({ event_id: 'x' })); // envelope inválido
    await redis.publish(`wc:events:${valid.account_id}`, JSON.stringify(valid));
    await sleep(300);
    expect(got).toEqual([valid]);
    await rf.stop();
  });
});

/** Espera uma condição sem depender de tempo fixo. */
async function vi_waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await sleep(25);
  }
  throw new Error('timeout esperando condição');
}
