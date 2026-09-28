import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { NormalizedEvent } from '@waychat/channels';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import type { ObjectStore } from '@waychat/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreConfigFromEnv, createCtx, type Ctx } from './context.js';
import {
  authenticate,
  claimWhatsAppSend,
  completeUpload,
  connectWhatsApp,
  createInbox,
  getConversation,
  loadWhatsAppTarget,
  login,
  outboundContentFor,
  processWhatsAppEvent,
  receiveInboundMessage,
  recordWhatsAppFailed,
  recordWhatsAppSent,
  registerAccount,
  requestUpload,
  sendMessage,
  SendPendingError,
  type Actor,
  type WhatsAppTarget,
} from './index.js';

let t: TestDb;
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const PASSWORD = 'uma-senha-bem-longa-42';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

class MemStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  presigned: string[] = [];
  presignUpload(key: string) {
    this.presigned.push(key);
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

const store = new MemStore();
let ctx: Ctx;

beforeAll(async () => {
  t = await startTestDb();
  const cfg = coreConfigFromEnv({
    SESSION_SECRET: 'q'.repeat(48),
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_PREVIOUS: undefined,
  });
  ctx = createCtx(t.app.db, cfg, undefined, {
    store,
    scanner: null,
    enqueueScan: () => Promise.resolve(),
  });
});
afterAll(async () => {
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
    phoneNumberId: String(500000000000000 + n),
    wabaId: String(600000000000000 + n),
    accessToken: 'x'.repeat(30),
    appSecret: 'y'.repeat(20),
  });
  const target = await loadWhatsAppTarget(ctx, accountId, inbox.id);
  if (!target) throw new Error('esperava encontrar o alvo');
  return { accountId, owner, inbox, target };
}

/** Cria a conversa via uma mensagem de entrada de verdade (contato com identidade "whatsapp" e um wamid citável). */
async function conversationOf(target: WhatsAppTarget, providerId = `wamid.${uniq()}`) {
  const event: Extract<NormalizedEvent, { kind: 'message' }> = {
    kind: 'message',
    providerId,
    accountRef: target.config.phoneNumberId,
    from: { id: 'wa-5511988887777', name: 'Maria' },
    at: new Date('2026-01-15T12:00:00.000Z'),
    content: { type: 'text', body: 'oi' },
  };
  await processWhatsAppEvent(ctx, target, event);
  const row = await t.owner.pool.query(
    `select cv.id as conversation_id, m.id as message_id from conversations cv
     join messages m on m.conversation_id = cv.id and m.source_id = $1
     where cv.inbox_id = $2`,
    [providerId, target.inboxId],
  );
  return row.rows[0] as { conversation_id: string; message_id: string };
}

async function cleanAttachment(accountId: string, inboxId: string, owner: Actor) {
  const subject = { accountId, inboxId, uploaderType: 'user' as const, uploaderId: owner.userId };
  const req = await requestUpload(ctx, subject, { fileName: 'foto.png', size: PNG.length });
  store.objects.set(store.presigned.at(-1) ?? '', PNG);
  const done = await completeUpload(ctx, subject, req.attachment.id);
  return done.id;
}

describe('sendMessage: status inicial por canal', () => {
  it('inbox WhatsApp nasce "queued"; nota interna continua "sent" mesmo assim', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const reply = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'Olá!',
      clientMessageId: crypto.randomUUID(),
    });
    expect(reply.message.status).toBe('queued');

    const note = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'nota interna',
      private: true,
      clientMessageId: crypto.randomUUID(),
    });
    expect(note.message.status).toBe('sent');
  });
});

describe('claimWhatsAppSend: reivindicação e reconciliação (ADR 0011)', () => {
  it('mensagem "queued": marca "sending", soma uma tentativa e devolve o destino', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'Oi!',
      clientMessageId: crypto.randomUUID(),
    });
    const claim = await claimWhatsAppSend(ctx, s.accountId, sent.message.id, {
      pastWaitWindow: false,
    });
    expect(claim).toMatchObject({
      to: 'wa-5511988887777',
      message: { content: 'Oi!' },
      attachment: null,
    });
    const row = await t.owner.pool.query('select status, attempts from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sending', attempts: 1 });
  });

  it('mensagem já resolvida (sent/delivered/read/failed): devolve null e não toca em nada', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    for (const status of ['sent', 'delivered', 'read', 'failed']) {
      const sent = await sendMessage(ctx, s.owner, {
        conversationId: conv.conversation_id,
        content: 'x',
        clientMessageId: crypto.randomUUID(),
      });
      await t.owner.pool.query('update messages set status = $1 where id = $2', [
        status,
        sent.message.id,
      ]);
      expect(
        await claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false }),
      ).toBeNull();
      const row = await t.owner.pool.query('select status from messages where id = $1', [
        sent.message.id,
      ]);
      expect(row.rows[0].status).toBe(status); // não mudou
    }
  });

  it('"sending" com wamid já gravado (o passo 3 não terminou): conclui para "sent" e devolve null', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query(
      "update messages set status = 'sending', source_id = 'wamid.JAENVIADO' where id = $1",
      [sent.message.id],
    );
    expect(
      await claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false }),
    ).toBeNull();
    const row = await t.owner.pool.query('select status from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0].status).toBe('sent');
  });

  it('"sending" sem wamid, ainda dentro da janela: lança SendPendingError sem tocar nada', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query("update messages set status = 'sending', attempts = 1 where id = $1", [
      sent.message.id,
    ]);
    await expect(
      claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false }),
    ).rejects.toBeInstanceOf(SendPendingError);
    const row = await t.owner.pool.query('select status, attempts from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sending', attempts: 1 }); // sem mudança
  });

  it('"sending" sem wamid, fora da janela: tenta de novo (soma outra tentativa)', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await t.owner.pool.query("update messages set status = 'sending', attempts = 1 where id = $1", [
      sent.message.id,
    ]);
    const claim = await claimWhatsAppSend(ctx, s.accountId, sent.message.id, {
      pastWaitWindow: true,
    });
    expect(claim).not.toBeNull();
    const row = await t.owner.pool.query('select status, attempts from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sending', attempts: 2 });
  });

  it('resposta citada leva o wamid da mensagem original', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const original = await t.owner.pool.query(
      'select id from messages where conversation_id = $1',
      [conv.conversation_id],
    );
    const reply = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'respondendo',
      replyToId: (original.rows[0] as { id: string }).id,
      clientMessageId: crypto.randomUUID(),
    });
    const claim = await claimWhatsAppSend(ctx, s.accountId, reply.message.id, {
      pastWaitWindow: false,
    });
    expect(claim?.replyToProviderId).toBeDefined();
  });

  it('mais de um anexo limpo: marca "failed" na hora, sem chamar a Graph API', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const a1 = await cleanAttachment(s.accountId, s.inbox.id, s.owner);
    const a2 = await cleanAttachment(s.accountId, s.inbox.id, s.owner);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'duas fotos',
      attachmentIds: [a1, a2],
      clientMessageId: crypto.randomUUID(),
    });
    expect(
      await claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false }),
    ).toBeNull();
    const row = await t.owner.pool.query('select status, error_code from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'failed', error_code: 'too_many_attachments' });
  });
});

describe('outboundContentFor', () => {
  it('texto puro', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'Olá cliente',
      clientMessageId: crypto.randomUUID(),
    });
    const claim = await claimWhatsAppSend(ctx, s.accountId, sent.message.id, {
      pastWaitWindow: false,
    });
    expect(claim).not.toBeNull();
    expect(await outboundContentFor(ctx, claim!)).toEqual({ type: 'text', body: 'Olá cliente' });
  });

  it('imagem com legenda vira media por link', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const attId = await cleanAttachment(s.accountId, s.inbox.id, s.owner);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'Segue a foto',
      attachmentIds: [attId],
      clientMessageId: crypto.randomUUID(),
    });
    const claim = await claimWhatsAppSend(ctx, s.accountId, sent.message.id, {
      pastWaitWindow: false,
    });
    const content = await outboundContentFor(ctx, claim!);
    expect(content).toMatchObject({ type: 'image', caption: 'Segue a foto' });
    if (content.type === 'image') expect(content.media).toHaveProperty('link');
  });
});

describe('recordWhatsAppSent / recordWhatsAppFailed', () => {
  it('sent grava o wamid e o status; chamar de novo é inofensivo (idempotente)', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false });
    await recordWhatsAppSent(ctx, s.accountId, sent.message.id, 'wamid.OUT99');
    let row = await t.owner.pool.query('select status, source_id from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sent', source_id: 'wamid.OUT99' });
    await expect(
      recordWhatsAppSent(ctx, s.accountId, sent.message.id, 'wamid.OUTRO'),
    ).resolves.toBeUndefined();
    row = await t.owner.pool.query('select status, source_id from messages where id = $1', [
      sent.message.id,
    ]);
    expect(row.rows[0]).toEqual({ status: 'sent', source_id: 'wamid.OUT99' }); // não sobrescreve o já resolvido
  });

  it('failed grava o motivo em português e o código', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const sent = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'x',
      clientMessageId: crypto.randomUUID(),
    });
    await claimWhatsAppSend(ctx, s.accountId, sent.message.id, { pastWaitWindow: false });
    await recordWhatsAppFailed(
      ctx,
      s.accountId,
      sent.message.id,
      'window_closed',
      'A janela de 24 horas fechou.',
    );
    const row = await t.owner.pool.query(
      'select status, error, error_code from messages where id = $1',
      [sent.message.id],
    );
    expect(row.rows[0]).toEqual({
      status: 'failed',
      error: 'A janela de 24 horas fechou.',
      error_code: 'window_closed',
    });
  });
});

describe('janela de 24h (D7)', () => {
  it('getConversation: aberta logo após a mensagem do cliente; null para canal sem janela', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    const detail = await getConversation(ctx, s.owner, conv.conversation_id);
    expect(detail.window).toMatchObject({ open: true });
    expect(detail.window?.expiresAt).toBeInstanceOf(Date);

    const widget = await createInbox(ctx, s.owner, { name: 'Site', channelType: 'widget' });
    const inbound = await receiveInboundMessage(ctx, {
      accountId: s.accountId,
      inboxId: widget.inbox.id,
      identity: { channel: 'widget', externalId: 'v1', name: 'Visitante' },
      content: 'oi',
    });
    const widgetDetail = await getConversation(ctx, s.owner, inbound.conversationId);
    expect(widgetDetail.window).toBeNull();
  });

  it('sendMessage: janela fechada bloqueia texto/mídia, mas nunca uma nota interna', async () => {
    const s = await setup();
    const conv = await conversationOf(s.target);
    await t.owner.pool.query(
      "update conversations set last_customer_message_at = now() - interval '25 hours' where id = $1",
      [conv.conversation_id],
    );
    await expect(
      sendMessage(ctx, s.owner, {
        conversationId: conv.conversation_id,
        content: 'oi de novo',
        clientMessageId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'window_closed' });
    // nota interna nunca sai para o cliente: não é bloqueada pela janela
    const note = await sendMessage(ctx, s.owner, {
      conversationId: conv.conversation_id,
      content: 'nota apesar da janela fechada',
      private: true,
      clientMessageId: crypto.randomUUID(),
    });
    expect(note.message.status).toBe('sent');
  });

  it('sendMessage: canal sem janela nunca é bloqueado, mesmo sem mensagem recente do cliente', async () => {
    const s = await setup();
    const widget = await createInbox(ctx, s.owner, { name: 'Site', channelType: 'widget' });
    const inbound = await receiveInboundMessage(ctx, {
      accountId: s.accountId,
      inboxId: widget.inbox.id,
      identity: { channel: 'widget', externalId: 'v1', name: 'Visitante' },
      content: 'oi',
    });
    await t.owner.pool.query(
      "update conversations set last_customer_message_at = now() - interval '200 hours' where id = $1",
      [inbound.conversationId],
    );
    const reply = await sendMessage(ctx, s.owner, {
      conversationId: inbound.conversationId,
      content: 'sem problema',
      clientMessageId: crypto.randomUUID(),
    });
    expect(reply.message.status).toBe('sent');
  });
});
