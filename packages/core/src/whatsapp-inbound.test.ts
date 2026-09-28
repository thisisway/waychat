import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import type { InboundContent, NormalizedEvent } from '@waychat/channels';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import type { ObjectStore } from '@waychat/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coreConfigFromEnv, createCtx, type Ctx } from './context.js';
import {
  authenticate,
  connectWhatsApp,
  listMessages,
  listWhatsAppTemplates,
  loadWhatsAppByPublicKey,
  login,
  processWhatsAppEvent,
  registerAccount,
  upsertTemplateFromMeta,
  type Actor,
  type WhatsAppTarget,
} from './index.js';

/** Armazenamento em memória: a mídia "baixada da Meta" já chega em bytes, então só precisa gravar e ler de volta. */
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

let t: TestDb;
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const PASSWORD = 'uma-senha-bem-longa-42';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const EXE = new TextEncoder().encode('MZ\x90\0\x03\0\0\0 programa');

const store = new MemStore();
let ctx: Ctx;

beforeAll(async () => {
  t = await startTestDb();
  const cfg = coreConfigFromEnv({
    SESSION_SECRET: 'w'.repeat(48),
    MASTER_KEY: randomBytes(32).toString('base64'),
    MASTER_KEY_PREVIOUS: undefined,
  });
  // sem antivírus: o arquivo vale como "clean" na hora (comportamento de desenvolvimento, já coberto em attachments.test.ts)
  ctx = createCtx(t.app.db, cfg, undefined, {
    store,
    scanner: null,
    enqueueScan: () => Promise.resolve(),
  });
});
afterAll(async () => {
  await t.stop();
});

async function setup(over: { optOutKeywords?: string[] } = {}) {
  const email = `dono-${uniq()}@exemplo.com`;
  await registerAccount(ctx, { accountName: 'Loja', ownerName: 'Dono', email, password: PASSWORD });
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  const owner: Actor = await authenticate(ctx, r.tokens.accessToken);
  const { inbox } = await connectWhatsApp(ctx, owner, {
    name: `WhatsApp ${uniq()}`,
    phoneNumberId: String(100000000000000 + n),
    wabaId: String(200000000000000 + n),
    accessToken: 'x'.repeat(30),
    appSecret: 'y'.repeat(20),
    ...(over.optOutKeywords ? { optOutKeywords: over.optOutKeywords } : {}),
  });
  const target = await loadWhatsAppByPublicKey(ctx, inbox.publicKey);
  if (!target) throw new Error('esperava encontrar o alvo');
  return { owner, inbox, target };
}

const msg = (
  target: WhatsAppTarget,
  providerId: string,
  content: InboundContent,
  over: { replyToProviderId?: string; name?: string } = {},
): Extract<NormalizedEvent, { kind: 'message' }> => ({
  kind: 'message',
  providerId,
  accountRef: target.config.phoneNumberId,
  from: { id: 'wa-5511988887777', ...(over.name ? { name: over.name } : {}) },
  at: new Date('2026-01-15T12:00:00.000Z'),
  ...(over.replyToProviderId ? { replyToProviderId: over.replyToProviderId } : {}),
  content,
});

const messagesOf = async (owner: Actor, conversationId: string) =>
  (await listMessages(ctx, owner, conversationId)).items.reverse(); // mais antiga primeiro

describe('mensagens de entrada do WhatsApp', () => {
  it('texto cria contato (com o nome do perfil) e conversa; reenvio do mesmo wamid não duplica', async () => {
    const s = await setup();
    const event = msg(s.target, 'wamid.T1', { type: 'text', body: 'Olá' }, { name: 'Maria Souza' });
    await processWhatsAppEvent(ctx, s.target, event);
    await processWhatsAppEvent(ctx, s.target, event); // reentrega (job repetido)

    const rows = await t.owner.pool.query(
      `select c.name, m.content, m.type, m.source_id from messages m join contacts c on c.id = m.sender_id
       where m.inbox_id = $1`,
      [s.inbox.id],
    );
    expect(rows.rows).toEqual([
      { name: 'Maria Souza', content: 'Olá', type: 'text', source_id: 'wamid.T1' },
    ]);
  });

  it('resposta citada resolve o id local; sem a original, não quebra e fica sem citação', async () => {
    const s = await setup();
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(s.target, 'wamid.ORIG', { type: 'text', body: 'primeira' }),
    );
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(
        s.target,
        'wamid.REPLY',
        { type: 'text', body: 'respondendo' },
        { replyToProviderId: 'wamid.ORIG' },
      ),
    );
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(
        s.target,
        'wamid.ORFA',
        { type: 'text', body: 'cita algo que não temos' },
        { replyToProviderId: 'wamid.nunca-existiu' },
      ),
    );
    const rows = (
      await t.owner.pool.query(
        `select m.source_id, m.reply_to_id, orig.id as orig_id from messages m
         left join messages orig on orig.source_id = 'wamid.ORIG' and orig.account_id = m.account_id
         where m.account_id = (select account_id from inboxes where id = $1) order by m.created_at`,
        [s.inbox.id],
      )
    ).rows as { source_id: string; reply_to_id: string | null; orig_id: string }[];
    const reply = rows.find((r) => r.source_id === 'wamid.REPLY');
    const orfa = rows.find((r) => r.source_id === 'wamid.ORFA');
    expect(reply?.reply_to_id).toBe(reply?.orig_id);
    expect(orfa?.reply_to_id).toBeNull();
  });

  it('reação, resposta de botão/lista e localização gravam sem crashar (allowEmpty)', async () => {
    const s = await setup();
    for (const [id, content] of [
      ['wamid.R1', { type: 'reaction', targetProviderId: 'wamid.ORIG', emoji: '👍' }],
      ['wamid.R2', { type: 'button_reply', replyId: 'a', title: 'Sim' }],
      ['wamid.R3', { type: 'list_reply', replyId: 'b', title: 'Plano A' }],
      ['wamid.R4', { type: 'location', latitude: -23.5, longitude: -46.6 }],
      ['wamid.R5', { type: 'unsupported', providerType: 'order' }],
    ] as const) {
      await processWhatsAppEvent(ctx, s.target, msg(s.target, id, content));
    }
    const rows = (
      await t.owner.pool.query(
        `select source_id, type, content from messages where account_id = (select account_id from inboxes where id = $1) order by created_at`,
        [s.inbox.id],
      )
    ).rows;
    expect(rows).toEqual([
      { source_id: 'wamid.R1', type: 'reaction', content: '👍' },
      { source_id: 'wamid.R2', type: 'button_reply', content: 'Sim' },
      { source_id: 'wamid.R3', type: 'list_reply', content: 'Plano A' },
      { source_id: 'wamid.R4', type: 'location', content: '' },
      { source_id: 'wamid.R5', type: 'unsupported', content: '' },
    ]);
  });

  it('imagem com bytes válidos vira anexo "clean" ligado à mensagem', async () => {
    const s = await setup();
    const event = msg(s.target, 'wamid.IMG1', {
      type: 'image',
      media: { id: '9001', mimeType: 'image/png' },
      caption: 'Comprovante',
    });
    await processWhatsAppEvent(ctx, s.target, event, {
      fileName: 'media-9001.png',
      buffer: Buffer.from(PNG),
    });
    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id where m.source_id = 'wamid.IMG1'`,
    );
    const items = await messagesOf(s.owner, (conv.rows[0] as { id: string }).id);
    expect(items[0]).toMatchObject({ content: 'Comprovante', type: 'image' });
    expect(items[0]?.attachments).toMatchObject([
      { fileName: 'media-9001.png', contentType: 'image/png', status: 'clean' },
    ]);
  });

  it('mídia com bytes inválidos (assinatura não bate) grava a mensagem sem anexo, nunca some em silêncio', async () => {
    const s = await setup();
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(s.target, 'wamid.BAD1', {
        type: 'document',
        media: { id: '9002', mimeType: 'application/pdf' },
      }),
      { fileName: 'fatura.pdf', buffer: Buffer.from(EXE) },
    );
    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id where m.source_id = 'wamid.BAD1'`,
    );
    const items = await messagesOf(s.owner, (conv.rows[0] as { id: string }).id);
    expect(items).toHaveLength(1);
    expect(items[0]?.attachments).toEqual([]);
  });

  it('mídia sem bytes fornecidos (o chamador não conseguiu baixar) também não quebra', async () => {
    const s = await setup();
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(s.target, 'wamid.NOFETCH', {
        type: 'image',
        media: { id: '9003', mimeType: 'image/png' },
      }),
    );
    const conv = await t.owner.pool.query(
      `select cv.id from conversations cv join messages m on m.conversation_id = cv.id where m.source_id = 'wamid.NOFETCH'`,
    );
    expect(conv.rows).toHaveLength(1);
  });

  it('opt-out: palavra EXATA (sem acento/caixa) registra; conter a palavra no meio da frase não conta', async () => {
    const s = await setup({ optOutKeywords: ['sair', 'Cancelar'] });
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(s.target, 'wamid.OO1', { type: 'text', body: 'SÁIR' }),
    );
    await processWhatsAppEvent(
      ctx,
      s.target,
      msg(s.target, 'wamid.OO2', { type: 'text', body: 'vou sair de férias' }),
    );
    const rows = await t.owner.pool.query(
      `select keyword from contact_opt_outs where account_id = (select account_id from inboxes where id = $1)`,
      [s.inbox.id],
    );
    expect(rows.rows).toEqual([{ keyword: 'SAIR' }]);
  });
});

describe('status de entrega do WhatsApp', () => {
  async function outboundMessage(s: Awaited<ReturnType<typeof setup>>, sourceId: string) {
    const accountId = (
      await t.owner.pool.query('select account_id from inboxes where id = $1', [s.inbox.id])
    ).rows[0].account_id as string;
    const contact = await t.owner.pool.query(
      `insert into contacts (id, account_id, name) values (gen_random_uuid(), $1, 'Cliente') returning id`,
      [accountId],
    );
    const conv = await t.owner.pool.query(
      `insert into conversations (id, account_id, inbox_id, contact_id) values (gen_random_uuid(), $1, $2, $3) returning id`,
      [accountId, s.inbox.id, contact.rows[0].id],
    );
    await t.owner.pool.query(
      `insert into messages (id, account_id, conversation_id, inbox_id, direction, sender_type, content, source_id, status)
       values (gen_random_uuid(), $1, $2, $3, 'out', 'user', 'oi', $4, 'queued')`,
      [accountId, conv.rows[0].id, s.inbox.id, sourceId],
    );
    return accountId;
  }
  const statusOf = async (accountId: string, sourceId: string) =>
    (
      await t.owner.pool.query(
        'select status, error, error_code from messages where account_id = $1 and source_id = $2',
        [accountId, sourceId],
      )
    ).rows[0] as { status: string; error: string | null; error_code: string | null };

  const status = (
    target: WhatsAppTarget,
    providerId: string,
    st: 'sent' | 'delivered' | 'read' | 'failed',
    error?: { code: number; title: string; message: string },
  ): Extract<NormalizedEvent, { kind: 'status' }> => ({
    kind: 'status',
    providerId,
    accountRef: target.config.phoneNumberId,
    status: st,
    recipientId: 'wa-5511988887777',
    at: new Date('2026-01-15T12:00:00.000Z'),
    ...(error ? { error } : {}),
  });

  it('avança em ordem: sent -> delivered -> read', async () => {
    const s = await setup();
    const accountId = await outboundMessage(s, 'wamid.OUT1');
    for (const st of ['sent', 'delivered', 'read'] as const) {
      await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT1', st));
      expect((await statusOf(accountId, 'wamid.OUT1')).status).toBe(st);
    }
  });

  it('fora de ordem (delivered chega antes de sent) é ignorado; nunca "anda para trás"', async () => {
    const s = await setup();
    const accountId = await outboundMessage(s, 'wamid.OUT2');
    await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT2', 'read'));
    await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT2', 'sent')); // chega depois, atrasado
    expect((await statusOf(accountId, 'wamid.OUT2')).status).toBe('read');
  });

  it('failed vale antes de "delivered", grava o erro e depois é terminal', async () => {
    const s = await setup();
    const accountId = await outboundMessage(s, 'wamid.OUT3');
    await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT3', 'sent'));
    await processWhatsAppEvent(
      ctx,
      s.target,
      status(s.target, 'wamid.OUT3', 'failed', {
        code: 131047,
        title: 'x',
        message: 'Janela fechada',
      }),
    );
    expect(await statusOf(accountId, 'wamid.OUT3')).toEqual({
      status: 'failed',
      error: 'Janela fechada',
      error_code: '131047',
    });
    // um "delivered" atrasado não ressuscita a mensagem
    await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT3', 'delivered'));
    expect((await statusOf(accountId, 'wamid.OUT3')).status).toBe('failed');
  });

  it('failed depois de "delivered" é ignorado (já confirmado, não regride)', async () => {
    const s = await setup();
    const accountId = await outboundMessage(s, 'wamid.OUT4');
    await processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.OUT4', 'delivered'));
    await processWhatsAppEvent(
      ctx,
      s.target,
      status(s.target, 'wamid.OUT4', 'failed', { code: 1, title: 'x', message: 'x' }),
    );
    expect((await statusOf(accountId, 'wamid.OUT4')).status).toBe('delivered');
  });

  it('status de um wamid desconhecido não encontra mensagem e não lança', async () => {
    const s = await setup();
    await expect(
      processWhatsAppEvent(ctx, s.target, status(s.target, 'wamid.nunca-existiu', 'sent')),
    ).resolves.toBeUndefined();
  });

  it('evento de qualidade ainda não faz nada (passo 9), mas não lança', async () => {
    const s = await setup();
    await expect(
      processWhatsAppEvent(ctx, s.target, {
        kind: 'quality',
        wabaId: s.target.config.wabaId,
        displayPhone: '5511999990000',
        event: 'FLAGGED',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('template_status (D8)', () => {
  const templateStatus = (
    target: WhatsAppTarget,
    over: {
      providerTemplateId?: string;
      name?: string;
      status?: 'approved' | 'rejected' | 'pending' | 'paused' | 'disabled' | 'other';
      reason?: string;
    } = {},
  ): Extract<NormalizedEvent, { kind: 'template_status' }> => ({
    kind: 'template_status',
    wabaId: target.config.wabaId,
    providerTemplateId: over.providerTemplateId ?? '1001',
    name: over.name ?? 'boas_vindas',
    language: 'pt_BR',
    status: over.status ?? 'approved',
    ...(over.reason ? { reason: over.reason } : {}),
  });

  it('webhook de status cria o template (sem categoria/componentes ainda: sync nunca rodou)', async () => {
    const s = await setup();
    await processWhatsAppEvent(ctx, s.target, templateStatus(s.target, { status: 'pending' }));
    const rows = await listWhatsAppTemplates(ctx, s.owner, s.inbox.id);
    expect(rows).toMatchObject([
      {
        providerTemplateId: '1001',
        name: 'boas_vindas',
        language: 'pt_BR',
        category: 'UTILITY',
        status: 'pending',
        reason: null,
        components: [],
      },
    ]);
  });

  it('reentrega/avanço de status atualiza a mesma linha (chave inbox+nome+idioma), sem duplicar', async () => {
    const s = await setup();
    await processWhatsAppEvent(ctx, s.target, templateStatus(s.target, { status: 'pending' }));
    await processWhatsAppEvent(
      ctx,
      s.target,
      templateStatus(s.target, { status: 'rejected', reason: 'INVALID_FORMAT' }),
    );
    const rows = await listWhatsAppTemplates(ctx, s.owner, s.inbox.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'rejected', reason: 'INVALID_FORMAT' });
  });

  it('status-only não apaga categoria/componentes já sincronizados antes', async () => {
    const s = await setup();
    await upsertTemplateFromMeta(ctx, s.target.accountId, s.target.inboxId, {
      providerTemplateId: '1001',
      name: 'boas_vindas',
      language: 'pt_BR',
      category: 'MARKETING',
      status: 'pending',
      components: [{ type: 'BODY', text: 'Olá {{1}}' }],
    });
    await processWhatsAppEvent(ctx, s.target, templateStatus(s.target, { status: 'approved' }));
    const rows = await listWhatsAppTemplates(ctx, s.owner, s.inbox.id);
    expect(rows[0]).toMatchObject({
      status: 'approved',
      category: 'MARKETING',
      components: [{ type: 'BODY', text: 'Olá {{1}}' }],
    });
  });
});
