import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  authenticate,
  createCtx,
  createInbox,
  login,
  completeUpload,
  registerAccount,
  requestUpload,
  scanAttachment,
  sendMessage,
  updateInbox,
  type AuthenticatedActor,
  type Ctx,
} from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { eventEnvelopeSchema, loadEnv, type EventEnvelope } from '@waychat/shared';
import type { FastifyInstance } from 'fastify';
import { io as connectClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { EventFeed } from './realtime.js';
import { PNG, testFiles } from './test-files.js';

const PANEL = 'http://localhost:5173';
const SITE = 'https://loja.example.com';
const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let t: TestDb;
let ctx: Ctx;
const fileServices = testFiles();
let app: FastifyInstance;
let port: number;

const listeners: ((e: EventEnvelope) => void)[] = [];
const feed: EventFeed = {
  start: (cb) => {
    listeners.push(cb);
    return Promise.resolve();
  },
  stop: () => Promise.resolve(),
};
const pumped = new Map<string, number>();
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

async function shop(origins: string[] = [SITE]) {
  const email = `dono-${uniq()}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Loja',
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  const owner: AuthenticatedActor = await authenticate(ctx, r.tokens.accessToken);
  const { inbox, identitySecret } = await createInbox(ctx, owner, {
    name: 'Site',
    channelType: 'widget',
    welcomeMessage: 'Oi! Como ajudamos?',
    allowedOrigins: origins,
  });
  await pump(accountId);
  return { accountId, owner, inbox, secret: identitySecret ?? '' };
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: body as object, headers, remoteAddress: fakeIp() });
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers, remoteAddress: fakeIp() });
/** Cada chamada usa um IP próprio para não dividir a cota de rate limit. */
const fakeIp = () => `10.2.${String(Math.floor(n / 250))}.${String((++n % 250) + 1)}`;

async function open(publicKey: string, extra: Record<string, unknown> = {}, origin = SITE) {
  const res = await post('/widget/v1/session', { public_key: publicKey, ...extra }, { origin });
  expect(res.statusCode, res.body).toBe(200);
  const b = res.json();
  return { token: b.token as string, visitorId: b.visitor_id as string | null, body: b };
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}`, origin: SITE });

beforeAll(async () => {
  t = await startTestDb();
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
    SESSION_SECRET: 'w'.repeat(48),
  });
  ctx = createCtx(
    t.app.db,
    {
      sessionSecret: env.SESSION_SECRET,
      masterKey: env.MASTER_KEY,
      masterKeyPrevious: [],
      accessTtlSeconds: 600,
      refreshTtlSeconds: 30 * 86400,
      challengeTtlSeconds: 300,
      issuer: 'WayChat',
    },
    undefined,
    fileServices.files,
  );
  const built = await buildApp({ env, ctx, logger: false, realtime: { feed } });
  app = built.app;
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
});

const sockets: Socket[] = [];
afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await app.close();
  await t.stop();
});

describe('sessão do widget', () => {
  it('abre sessão anônima e devolve a configuração pública; o visitor_id volta igual ao reenviar', async () => {
    const { inbox } = await shop();
    const a = await open(inbox.publicKey);
    expect(a.visitorId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(a.body).toMatchObject({
      identified: false,
      inbox: { name: 'Site', welcome_message: 'Oi! Como ajudamos?' },
    });
    const again = await open(inbox.publicKey, { visitor_id: a.visitorId });
    expect(again.visitorId).toBe(a.visitorId);
  });

  it('origem fora da lista (ou ausente) é recusada, e a lista vazia não libera ninguém', async () => {
    const { inbox } = await shop();
    const evil = await post(
      '/widget/v1/session',
      { public_key: inbox.publicKey },
      { origin: 'https://evil.example' },
    );
    expect(evil.statusCode).toBe(403);
    expect((await post('/widget/v1/session', { public_key: inbox.publicKey })).statusCode).toBe(
      403,
    );
    const closed = await shop([]);
    const res = await post(
      '/widget/v1/session',
      { public_key: closed.inbox.publicKey },
      { origin: SITE },
    );
    expect(res.statusCode).toBe(403);
  });

  it('chave desconhecida, inbox de API e inbox desativada respondem igual (404)', async () => {
    const s = await shop();
    const api = (await createInbox(ctx, s.owner, { name: 'CRM', channelType: 'api' })).inbox;
    await updateInbox(ctx, s.owner, s.inbox.id, { enabled: false });
    for (const key of ['ibx_naoexiste', api.publicKey, s.inbox.publicKey]) {
      const res = await post('/widget/v1/session', { public_key: key }, { origin: SITE });
      expect(res.statusCode, key).toBe(404);
    }
  });

  it('identidade: HMAC correto identifica o usuário; errado é recusado', async () => {
    const s = await shop();
    const hmac = (id: string, secret = s.secret) =>
      createHmac('sha256', secret).update(id).digest('hex');
    const ok = await open(s.inbox.publicKey, { identity: { user_id: 'u-42', hmac: hmac('u-42') } });
    expect(ok.body).toMatchObject({ identified: true, visitor_id: null });
    const bad = await post(
      '/widget/v1/session',
      { public_key: s.inbox.publicKey, identity: { user_id: 'u-42', hmac: hmac('u-42', 'outro') } },
      { origin: SITE },
    );
    expect(bad.statusCode).toBe(403);
    // HMAC de OUTRO usuário não serve para se passar por u-43
    const swap = await post(
      '/widget/v1/session',
      { public_key: s.inbox.publicKey, identity: { user_id: 'u-43', hmac: hmac('u-42') } },
      { origin: SITE },
    );
    expect(swap.statusCode).toBe(403);
  });

  it('CORS: o widget pode chamar de qualquer site, sem credenciais', async () => {
    const pre = await app.inject({
      method: 'OPTIONS',
      url: '/widget/v1/messages',
      headers: {
        origin: SITE,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
      remoteAddress: fakeIp(),
    });
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    // o painel continua restrito à própria origem
    const panel = await app.inject({
      method: 'OPTIONS',
      url: '/conversations',
      headers: { origin: SITE, 'access-control-request-method': 'GET' },
      remoteAddress: fakeIp(),
    });
    expect(panel.headers['access-control-allow-origin']).not.toBe('*');
    expect(panel.headers['access-control-allow-origin']).not.toBe(SITE);
  });
});

describe('mensagens do visitante', () => {
  it('sem token, com token inválido ou com token de outro tipo: 401', async () => {
    const s = await shop();
    expect((await get('/widget/v1/messages')).statusCode).toBe(401);
    expect((await get('/widget/v1/messages', bearer('lixo'))).statusCode).toBe(401);
    // access token do painel não vale como token de visitante
    const email = `u-${uniq()}@exemplo.com`;
    await registerAccount(ctx, {
      accountName: 'Outra',
      ownerName: 'O',
      email,
      password: PASSWORD,
    });
    const r = await login(ctx, { email, password: PASSWORD });
    if (r.status !== 'authenticated') throw new Error('esperava authenticated');
    expect((await get('/widget/v1/messages', bearer(r.tokens.accessToken))).statusCode).toBe(401);
    expect(s.inbox.id).toBeTruthy();
  });

  it('envia, o painel recebe a conversa, e reenviar com o mesmo client_message_id não duplica', async () => {
    const s = await shop();
    const v = await open(s.inbox.publicKey, { name: 'Maria', email: 'maria@exemplo.com' });
    const cmid = randomUUID();
    const first = await post(
      '/widget/v1/messages',
      { content: 'Olá!', client_message_id: cmid },
      bearer(v.token),
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().duplicate).toBe(false);
    const dup = await post(
      '/widget/v1/messages',
      { content: 'Olá!', client_message_id: cmid },
      bearer(v.token),
    );
    expect(dup.json()).toMatchObject({ duplicate: true, message: { id: first.json().message.id } });

    const rows = await t.owner.pool.query(
      `select c.name, c.email, count(m.*)::int as n from messages m
       join conversations cv on cv.id = m.conversation_id join contacts c on c.id = cv.contact_id
       where m.account_id = $1 group by c.name, c.email`,
      [s.accountId],
    );
    expect(rows.rows).toEqual([{ name: 'Maria', email: 'maria@exemplo.com', n: 1 }]);
  });

  it('valida o corpo: vazio, grande demais e client_message_id malformado', async () => {
    const s = await shop();
    const v = await open(s.inbox.publicKey);
    for (const body of [
      { content: 'x'.repeat(10_001) },
      { content: 'ok', client_message_id: 'nao-uuid' },
      { content: 'ok', attachment_ids: ['nao-uuid'] },
    ]) {
      expect((await post('/widget/v1/messages', body, bearer(v.token))).statusCode).toBe(400);
    }
    // sem texto e sem anexo: a regra é do domínio
    expect(
      (await post('/widget/v1/messages', { content: '   ' }, bearer(v.token))).statusCode,
    ).toBe(422);
    expect((await post('/widget/v1/messages', {}, bearer(v.token))).statusCode).toBe(422);
  });

  it('histórico: o visitante vê as próprias mensagens e as respostas, nunca notas privadas nem a conversa de outro', async () => {
    const s = await shop();
    const a = await open(s.inbox.publicKey);
    const b = await open(s.inbox.publicKey);
    await post('/widget/v1/messages', { content: 'segredo do A' }, bearer(a.token));
    await post('/widget/v1/messages', { content: 'mensagem do B' }, bearer(b.token));

    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id
       where m.content = 'segredo do A' and cv.account_id = $1`,
      [s.accountId],
    );
    const conversationId = (conv.rows[0] as { id: string }).id;
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'Resposta pública',
      clientMessageId: randomUUID(),
    });
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'nota interna: cliente chato',
      private: true,
      clientMessageId: randomUUID(),
    });

    const listA = await get('/widget/v1/messages', bearer(a.token));
    const items = listA.json().items as { from: string; content: string }[];
    expect(items.map((i) => [i.from, i.content])).toEqual([
      ['visitor', 'segredo do A'],
      ['agent', 'Resposta pública'],
    ]);
    expect(listA.body).not.toContain('nota interna');
    expect(listA.body).not.toContain('mensagem do B');
    expect(JSON.stringify(items)).not.toMatch(/sender|user_id|account/);

    // ao voltar (nova sessão com o mesmo visitor_id) a conversa continua a mesma
    const back = await open(s.inbox.publicKey, { visitor_id: a.visitorId });
    expect((await get('/widget/v1/messages', bearer(back.token))).json().items).toHaveLength(2);
    expect((await get('/widget/v1/messages', bearer(b.token))).json().items).toHaveLength(1);
  });

  it('usuário identificado mantém o histórico entre sessões, sem precisar de visitor_id', async () => {
    const s = await shop();
    const identity = {
      user_id: 'cliente-7',
      hmac: createHmac('sha256', s.secret).update('cliente-7').digest('hex'),
    };
    const one = await open(s.inbox.publicKey, { identity });
    await post('/widget/v1/messages', { content: 'primeira visita' }, bearer(one.token));
    const two = await open(s.inbox.publicKey, { identity });
    const items = (await get('/widget/v1/messages', bearer(two.token))).json().items;
    expect(items.map((i: { content: string }) => i.content)).toEqual(['primeira visita']);
  });

  it('inbox desativada depois da sessão: enviar deixa de funcionar', async () => {
    const s = await shop();
    const v = await open(s.inbox.publicKey);
    await updateInbox(ctx, s.owner, s.inbox.id, { enabled: false });
    const res = await post('/widget/v1/messages', { content: 'oi' }, bearer(v.token));
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

interface VisitorPush {
  id: string;
  from: string;
  content: string;
  attachments: { id: string; file_name: string }[];
}

function connectVisitorSocket(token: string, origin: string | null = SITE) {
  const socket = connectClient(`http://127.0.0.1:${String(port)}/widget`, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token },
    extraHeaders: origin ? { origin } : {},
  });
  sockets.push(socket);
  const messages: VisitorPush[] = [];
  socket.on('message', (m: VisitorPush) => messages.push(m));
  const ready = new Promise<void>((resolve, reject) => {
    socket.once('ready', () => {
      resolve();
    });
    socket.once('connect_error', reject);
  });
  return { socket, messages, ready };
}
const connectVisitor = connectVisitorSocket;

describe('tempo real do visitante', () => {
  it('sem token, token inválido ou origem não permitida: conexão recusada', async () => {
    const s = await shop();
    const v = await open(s.inbox.publicKey);
    await expect(connectVisitor('').ready).rejects.toBeDefined();
    await expect(connectVisitor('lixo').ready).rejects.toBeDefined();
    await expect(connectVisitor(v.token, 'https://evil.example').ready).rejects.toBeDefined();
    await expect(connectVisitor(v.token, null).ready).rejects.toBeDefined();
    await connectVisitor(v.token).ready;
  });

  it('a resposta do atendente chega só ao visitante dono da conversa; notas privadas nunca', async () => {
    const s = await shop();
    const a = await open(s.inbox.publicKey);
    const b = await open(s.inbox.publicKey);
    const ca = connectVisitor(a.token);
    const cb = connectVisitor(b.token);
    await Promise.all([ca.ready, cb.ready]);
    await post('/widget/v1/messages', { content: 'dúvida do A' }, bearer(a.token));
    await post('/widget/v1/messages', { content: 'dúvida do B' }, bearer(b.token));
    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id
       where m.content = 'dúvida do A' and cv.account_id = $1`,
      [s.accountId],
    );
    const conversationId = (conv.rows[0] as { id: string }).id;
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'nota só da equipe',
      private: true,
      clientMessageId: randomUUID(),
    });
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'Resposta para A',
      clientMessageId: randomUUID(),
    });
    await pump(s.accountId);
    await sleep(300);

    expect(ca.messages.map((m) => [m.from, m.content])).toEqual([['agent', 'Resposta para A']]);
    expect(cb.messages).toEqual([]); // nem a própria mensagem do B volta como "resposta"
  });
});

describe('anexos do visitante', () => {
  const upload = async (token: string, name = 'comprovante.png') => {
    const req = await post(
      '/widget/v1/attachments',
      { file_name: name, size: PNG.length },
      bearer(token),
    );
    expect(req.statusCode, req.body).toBe(201);
    const id = req.json().attachment.id as string;
    fileServices.store.objects.set(fileServices.store.lastKey, PNG);
    const done = await post(`/widget/v1/attachments/${id}/complete`, {}, bearer(token));
    expect(done.json().attachment.status).toBe('scanning');
    return id;
  };
  const varrer = (accountId: string, id: string) => scanAttachment(ctx, accountId, id);

  it('visitante envia arquivo (varrido) e o atendente o recebe na conversa', async () => {
    const s = await shop();
    const v = await open(s.inbox.publicKey);
    const id = await upload(v.token);
    // enquanto a varredura não termina, não pode ser enviado
    const cedo = await post(
      '/widget/v1/messages',
      { content: 'segue', attachment_ids: [id] },
      bearer(v.token),
    );
    expect(cedo.statusCode).toBe(422);
    await varrer(s.accountId, id);
    const sent = await post(
      '/widget/v1/messages',
      { content: '', attachment_ids: [id] },
      bearer(v.token),
    );
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json().message.attachments).toMatchObject([
      { id, file_name: 'comprovante.png', content_type: 'image/png' },
    ]);
    const list = (await get('/widget/v1/messages', bearer(v.token))).json().items;
    expect(list[0].attachments).toHaveLength(1);
    const url = await get(`/widget/v1/attachments/${id}/url`, bearer(v.token));
    expect(url.statusCode).toBe(200);
  });

  it('um visitante não usa nem baixa o arquivo de outro; extensão proibida é recusada', async () => {
    const s = await shop();
    const a = await open(s.inbox.publicKey);
    const b = await open(s.inbox.publicKey);
    const id = await upload(a.token);
    await varrer(s.accountId, id);
    expect((await get(`/widget/v1/attachments/${id}/url`, bearer(b.token))).statusCode).toBe(404);
    expect(
      (await post(`/widget/v1/attachments/${id}/complete`, {}, bearer(b.token))).statusCode,
    ).toBe(404);
    const roubo = await post(
      '/widget/v1/messages',
      { content: 'x', attachment_ids: [id] },
      bearer(b.token),
    );
    expect(roubo.statusCode).toBe(422);
    const exe = await post(
      '/widget/v1/attachments',
      { file_name: 'v.exe', size: 5 },
      bearer(a.token),
    );
    expect(exe.statusCode).toBe(422);
    expect((await post('/widget/v1/attachments', { file_name: 'a.png', size: 5 })).statusCode).toBe(
      401,
    );
  });

  it('a resposta do atendente com anexo chega ao visitante pelo socket, e só ele consegue baixar', async () => {
    const s = await shop();
    const a = await open(s.inbox.publicKey);
    const b = await open(s.inbox.publicKey);
    await post('/widget/v1/messages', { content: 'oi A' }, bearer(a.token));
    await post('/widget/v1/messages', { content: 'oi B' }, bearer(b.token));
    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id
       where m.content = 'oi A' and cv.account_id = $1`,
      [s.accountId],
    );
    const conversationId = (conv.rows[0] as { id: string }).id;

    // o atendente sobe um arquivo pela API do painel (core direto) e responde com ele
    const subject = {
      accountId: s.accountId,
      uploaderType: 'user' as const,
      uploaderId: s.owner.userId,
    };
    const { attachment } = await requestUpload(
      ctx,
      { ...subject, inboxId: s.inbox.id },
      { fileName: 'proposta.png', size: PNG.length },
    );
    fileServices.store.objects.set(fileServices.store.lastKey, PNG);
    await completeUpload(ctx, subject, attachment.id);
    await varrer(s.accountId, attachment.id);

    const socketA = connectVisitorSocket(a.token);
    await socketA.ready;
    await sendMessage(ctx, s.owner, {
      conversationId,
      content: 'Segue a proposta',
      attachmentIds: [attachment.id],
      clientMessageId: randomUUID(),
    });
    await pump(s.accountId);
    await sleep(300);
    expect(socketA.messages).toHaveLength(1);
    expect(socketA.messages[0]).toMatchObject({
      content: 'Segue a proposta',
      attachments: [{ id: attachment.id, file_name: 'proposta.png' }],
    });
    expect(
      (await get(`/widget/v1/attachments/${attachment.id}/url`, bearer(a.token))).statusCode,
    ).toBe(200);
    expect(
      (await get(`/widget/v1/attachments/${attachment.id}/url`, bearer(b.token))).statusCode,
    ).toBe(404);
  });
});
