import { randomBytes } from 'node:crypto';
import { schema, withTenant } from '@waychat/db';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { uuidv7 } from '@waychat/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx, type Ctx } from './context.js';
import { DomainError, type DomainErrorCode } from './errors.js';
import {
  addLabel,
  addMember,
  authenticate,
  conversationCounts,
  createCannedResponse,
  createInbox,
  createLabel,
  deleteCannedResponse,
  getConversation,
  listCannedResponses,
  listConversations,
  listMessages,
  login,
  markConversationRead,
  receiveInboundMessage,
  registerAccount,
  removeLabel,
  sendMessage,
  setInboxMembers,
  updateCannedResponse,
  updateConversation,
  updateInbox,
  type Actor,
} from './index.js';

let t: TestDb;
let ctx: Ctx;
const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectCode(p: Promise<unknown>, code: DomainErrorCode) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

async function actorOf(email: string): Promise<Actor> {
  const r = await login(ctx, { email, password: PASSWORD });
  if (r.status !== 'authenticated') throw new Error('esperava authenticated');
  return authenticate(ctx, r.tokens.accessToken);
}

async function roleId(accountId: string, name: string) {
  const [r] = await withTenant(t.app.db, accountId, (tx) =>
    tx.select().from(schema.roles).where(eq(schema.roles.name, name)),
  );
  if (!r) throw new Error(`papel ${name} ausente`);
  return r.id;
}

/** Conta com dono, dois agentes (A e B), um supervisor e duas inboxes; o agente A só é membro da inbox 1. */
async function setup() {
  const email = `dono-${uniq()}@exemplo.com`;
  const { accountId } = await registerAccount(ctx, {
    accountName: 'Acme',
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  const owner = await actorOf(email);
  const mk = async (role: string, name: string) => {
    const e = `${role.toLowerCase()}-${uniq()}@exemplo.com`;
    const { userId } = await addMember(ctx, owner, {
      email: e,
      name,
      password: PASSWORD,
      roleId: await roleId(accountId, role),
    });
    return { actor: await actorOf(e), id: userId };
  };
  const a = await mk('Agente', 'Agente A');
  const b = await mk('Agente', 'Agente B');
  const sup = await mk('Supervisor', 'Supervisora');
  const in1 = (await createInbox(ctx, owner, { name: 'Vendas', channelType: 'widget' })).inbox;
  const in2 = (await createInbox(ctx, owner, { name: 'Suporte', channelType: 'widget' })).inbox;
  await setInboxMembers(ctx, owner, in1.id, [a.id, b.id]);
  await setInboxMembers(ctx, owner, in2.id, [b.id]);
  return { accountId, owner, a, b, sup, in1, in2 };
}

const inbound = (
  accountId: string,
  inboxId: string,
  who: string,
  content: string,
  extra: { sourceId?: string; clientMessageId?: string } = {},
) =>
  receiveInboundMessage(ctx, {
    accountId,
    inboxId,
    identity: { channel: 'widget', externalId: who, name: `Visitante ${who}` },
    content,
    ...extra,
  });

beforeAll(async () => {
  t = await startTestDb();
  ctx = createCtx(t.app.db, {
    sessionSecret: 'x'.repeat(48),
    masterKey: randomBytes(32).toString('base64'),
    masterKeyPrevious: [],
    accessTtlSeconds: 600,
    refreshTtlSeconds: 30 * 86400,
    challengeTtlSeconds: 300,
    issuer: 'WayChat',
  });
});

afterAll(async () => {
  await t.stop();
});

describe('entrada de mensagens', () => {
  it('cria contato, conversa e mensagem; a segunda mensagem reaproveita a conversa', async () => {
    const { accountId, in1 } = await setup();
    const first = await inbound(accountId, in1.id, 'v1', 'Olá!');
    expect(first).toMatchObject({ conversationCreated: true, duplicate: false });
    const second = await inbound(accountId, in1.id, 'v1', 'Alguém aí?');
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.contactId).toBe(first.contactId);
    expect(second.conversationCreated).toBe(false);
    // outro visitante = outra conversa; o display_id segue a sequência da conta
    const other = await inbound(accountId, in1.id, 'v2', 'Oi');
    expect(other.conversationId).not.toBe(first.conversationId);
    const c1 = await withTenant(t.app.db, accountId, (tx) =>
      tx.select().from(schema.conversations).orderBy(schema.conversations.displayId),
    );
    expect(c1.map((c) => c.displayId)).toEqual([1, 2]);
  });

  it('entrega duplicada (mesmo source_id ou client_message_id) não grava de novo', async () => {
    const { accountId, in1 } = await setup();
    const cid = uuidv7();
    const a = await inbound(accountId, in1.id, 'v1', 'uma vez', {
      sourceId: 'ext-1',
      clientMessageId: cid,
    });
    const b = await inbound(accountId, in1.id, 'v1', 'uma vez', { sourceId: 'ext-1' });
    const c = await inbound(accountId, in1.id, 'v1', 'uma vez', { clientMessageId: cid });
    expect([b.duplicate, c.duplicate]).toEqual([true, true]);
    expect(b.message.id).toBe(a.message.id);
    expect(c.message.id).toBe(a.message.id);
    const rows = await t.owner.pool.query(
      'select count(*)::int as n from messages where account_id = $1',
      [accountId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('20 mensagens simultâneas do mesmo visitante: UMA conversa, 20 mensagens, ids únicos', async () => {
    const { accountId, in1 } = await setup();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        inbound(accountId, in1.id, 'rajada', `msg ${String(i)}`),
      ),
    );
    expect(new Set(results.map((r) => r.conversationId)).size).toBe(1);
    expect(results.filter((r) => r.conversationCreated)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(20);
    const convs = await t.owner.pool.query(
      'select count(*)::int as n from conversations where account_id = $1',
      [accountId],
    );
    expect(convs.rows[0].n).toBe(1);
  });

  it('a mesma entrega repetida em paralelo grava uma vez só', async () => {
    const { accountId, in1 } = await setup();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () =>
        inbound(accountId, in1.id, 'dup', 'x', { sourceId: 'wamid.same' }),
      ),
    );
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.message.id)).size).toBe(1);
  });

  it('conversa resolvida ou adiada reabre com mensagem nova do cliente', async () => {
    const { accountId, owner, in1 } = await setup();
    const first = await inbound(accountId, in1.id, 'v1', 'oi');
    await updateConversation(ctx, owner, first.conversationId, { status: 'resolved' });
    expect((await getConversation(ctx, owner, first.conversationId)).status).toBe('resolved');
    await inbound(accountId, in1.id, 'v1', 'voltei');
    const c = await getConversation(ctx, owner, first.conversationId);
    expect(c.status).toBe('open');
    expect(c.resolvedAt).toBeNull();
  });

  it('inbox desativada recusa; conteúdo vazio ou gigante também', async () => {
    const { accountId, owner, in1 } = await setup();
    await expectCode(inbound(accountId, in1.id, 'v1', '   '), 'invalid_input');
    await expectCode(inbound(accountId, in1.id, 'v1', 'x'.repeat(10_001)), 'invalid_input');
    await updateInbox(ctx, owner, in1.id, { enabled: false });
    await expectCode(inbound(accountId, in1.id, 'v1', 'oi'), 'inbox_disabled');
    await expectCode(inbound(accountId, uuidv7(), 'v1', 'oi'), 'not_found');
  });

  it('emite eventos com cursor contíguo e SEM conteúdo nem dados pessoais', async () => {
    const { accountId, in1 } = await setup();
    await inbound(accountId, in1.id, 'v1', 'texto sigiloso do cliente');
    await inbound(accountId, in1.id, 'v1', 'outro texto');
    const ev = await t.owner.pool.query(
      'select event_type, account_seq, payload::text as p from outbox where account_id = $1 order by account_seq',
      [accountId],
    );
    const types = ev.rows.map((r: { event_type: string }) => r.event_type);
    expect(types.filter((x: string) => x === 'conversation.created')).toHaveLength(1);
    expect(types.filter((x: string) => x === 'message.created')).toHaveLength(2);
    const seq = ev.rows.map((r: { account_seq: string }) => Number(r.account_seq));
    expect(seq).toEqual(seq.map((_, i) => (seq[0] ?? 0) + i)); // contíguo
    const dump = ev.rows.map((r: { p: string }) => r.p).join('');
    expect(dump).not.toContain('sigiloso');
    expect(dump).not.toContain('Visitante');
  });
});

describe('resposta do atendente', () => {
  it('responde, idempotente por client_message_id (inclusive em paralelo)', async () => {
    const { accountId, a, in1 } = await setup();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    const cid = uuidv7();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () =>
        sendMessage(ctx, a.actor, {
          conversationId,
          content: 'Já te atendo',
          clientMessageId: cid,
        }),
      ),
    );
    expect(rs.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.message.id)).size).toBe(1);
    const again = await sendMessage(ctx, a.actor, {
      conversationId,
      content: 'Já te atendo',
      clientMessageId: cid,
    });
    expect(again.duplicate).toBe(true);
    const rows = await t.owner.pool.query(
      "select count(*)::int as n from messages where conversation_id = $1 and direction = 'out'",
      [conversationId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('client_message_id não pode ser reaproveitado em outra conversa', async () => {
    const { accountId, a, in1 } = await setup();
    const c1 = await inbound(accountId, in1.id, 'v1', 'oi');
    const c2 = await inbound(accountId, in1.id, 'v2', 'oi');
    const cid = uuidv7();
    await sendMessage(ctx, a.actor, {
      conversationId: c1.conversationId,
      content: 'a',
      clientMessageId: cid,
    });
    await expectCode(
      sendMessage(ctx, a.actor, {
        conversationId: c2.conversationId,
        content: 'b',
        clientMessageId: cid,
      }),
      'invalid_input',
    );
  });

  it('nota interna fica marcada como privada; citação só da mesma conversa', async () => {
    const { accountId, a, in1 } = await setup();
    const c1 = await inbound(accountId, in1.id, 'v1', 'pergunta');
    const c2 = await inbound(accountId, in1.id, 'v2', 'outra');
    const note = await sendMessage(ctx, a.actor, {
      conversationId: c1.conversationId,
      content: 'cliente parece irritado',
      private: true,
      clientMessageId: uuidv7(),
      replyToId: c1.message.id,
    });
    expect(note.message).toMatchObject({
      private: true,
      direction: 'out',
      senderType: 'user',
      senderId: a.id,
      replyToId: c1.message.id,
    });
    await expectCode(
      sendMessage(ctx, a.actor, {
        conversationId: c1.conversationId,
        content: 'x',
        clientMessageId: uuidv7(),
        replyToId: c2.message.id,
      }),
      'invalid_input',
    );
    const ev = await t.owner.pool.query(
      "select payload from outbox where event_type = 'message.created' and aggregate_id = $1",
      [note.message.id],
    );
    expect(ev.rows[0].payload.private).toBe(true); // o gateway usa isto para nunca entregar nota ao cliente
  });

  it('valida entrada: conteúdo vazio, uuid ruim; sem permissão de resposta', async () => {
    const { accountId, a, in1 } = await setup();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    await expectCode(
      sendMessage(ctx, a.actor, { conversationId, content: '  ', clientMessageId: uuidv7() }),
      'invalid_input',
    );
    await expectCode(
      sendMessage(ctx, a.actor, { conversationId, content: 'ok', clientMessageId: 'nao-uuid' }),
      'invalid_input',
    );
    const noReply: Actor = { ...a.actor, permissions: new Set(['conversations:read']) };
    await expectCode(
      sendMessage(ctx, noReply, { conversationId, content: 'ok', clientMessageId: uuidv7() }),
      'forbidden',
    );
  });
});

describe('visibilidade por inbox (D5)', () => {
  it('agente só vê as conversas das inboxes de que é membro; supervisor e dono veem todas', async () => {
    const { accountId, owner, a, b, sup, in1, in2 } = await setup();
    const c1 = await inbound(accountId, in1.id, 'v1', 'na inbox 1');
    const c2 = await inbound(accountId, in2.id, 'v2', 'na inbox 2');
    const ids = async (actor: Actor) =>
      (await listConversations(ctx, actor)).items.map((c) => c.id).sort();
    expect(await ids(a.actor)).toEqual([c1.conversationId]);
    expect(await ids(b.actor)).toEqual([c1.conversationId, c2.conversationId].sort());
    expect(await ids(sup.actor)).toEqual([c1.conversationId, c2.conversationId].sort());
    expect(await ids(owner)).toEqual([c1.conversationId, c2.conversationId].sort());
  });

  it('conversa alheia responde not_found em TODAS as operações (não revela que existe)', async () => {
    const { accountId, a, in2 } = await setup();
    const { conversationId } = await inbound(accountId, in2.id, 'v2', 'privada da inbox 2');
    await expectCode(getConversation(ctx, a.actor, conversationId), 'not_found');
    await expectCode(listMessages(ctx, a.actor, conversationId), 'not_found');
    await expectCode(
      sendMessage(ctx, a.actor, { conversationId, content: 'invasão', clientMessageId: uuidv7() }),
      'not_found',
    );
    await expectCode(
      updateConversation(ctx, a.actor, conversationId, { status: 'resolved' }),
      'not_found',
    );
    await expectCode(markConversationRead(ctx, a.actor, conversationId), 'not_found');
    await expectCode(getConversation(ctx, a.actor, uuidv7()), 'not_found'); // inexistente: mesma resposta
  });

  it('sem nenhuma inbox, agente vê lista vazia; sem permissão de leitura, é recusado', async () => {
    const { accountId, owner, in1 } = await setup();
    await inbound(accountId, in1.id, 'v1', 'oi');
    const e = `solo-${uniq()}@exemplo.com`;
    await addMember(ctx, owner, {
      email: e,
      name: 'Solo',
      password: PASSWORD,
      roleId: await roleId(accountId, 'Agente'),
    });
    const solo = await actorOf(e);
    expect((await listConversations(ctx, solo)).items).toHaveLength(0);
    expect(await conversationCounts(ctx, solo)).toEqual({
      all: 0,
      unassigned: 0,
      mine: 0,
      unread: 0,
    });
    await expectCode(listConversations(ctx, { ...solo, permissions: new Set() }), 'forbidden');
  });

  it('isolamento entre contas', async () => {
    const one = await setup();
    const two = await setup();
    const c = await inbound(one.accountId, one.in1.id, 'v1', 'da conta um');
    await expectCode(getConversation(ctx, two.owner, c.conversationId), 'not_found');
    expect((await listConversations(ctx, two.owner)).items).toHaveLength(0);
  });
});

describe('listagem, filtros e paginação', () => {
  it('filtra por status, responsável, inbox, label, não lidas e busca', async () => {
    const { accountId, owner, a, b, in1, in2 } = await setup();
    const c1 = await inbound(accountId, in1.id, 'ana', 'quero comprar');
    const c2 = await inbound(accountId, in1.id, 'bia', 'suporte por favor');
    const c3 = await inbound(accountId, in2.id, 'caio', 'problema no pedido');
    await updateConversation(ctx, b.actor, c2.conversationId, { assigneeId: b.id });
    await updateConversation(ctx, owner, c3.conversationId, { status: 'resolved' });
    const label = await createLabel(ctx, owner, { name: 'vip', color: '#ff0000' });
    await addLabel(ctx, owner, c1.conversationId, label.id);
    await markConversationRead(ctx, b.actor, c1.conversationId);

    const list = async (actor: Actor, o: Parameters<typeof listConversations>[2]) =>
      (await listConversations(ctx, actor, o)).items.map((c) => c.id).sort();
    expect(await list(owner, { status: 'resolved' })).toEqual([c3.conversationId]);
    expect(await list(owner, { status: 'open' })).toEqual(
      [c1.conversationId, c2.conversationId].sort(),
    );
    expect(await list(b.actor, { assignee: 'me' })).toEqual([c2.conversationId]);
    expect(await list(b.actor, { assignee: 'unassigned' })).toEqual(
      [c1.conversationId, c3.conversationId].sort(),
    );
    expect(await list(owner, { inboxId: in2.id })).toEqual([c3.conversationId]);
    expect(await list(owner, { labelId: label.id })).toEqual([c1.conversationId]);
    expect(await list(b.actor, { unreadOnly: true })).toEqual(
      [c2.conversationId, c3.conversationId].sort(),
    );
    expect(await list(owner, { search: 'ANA' })).toEqual([c1.conversationId]);
    expect(await list(owner, { search: '2' })).toEqual([c2.conversationId]); // display_id
    expect(await list(a.actor, { assignee: b.id })).toEqual([c2.conversationId]);
  });

  it('pagina por (atividade, id) sem repetir nem pular, mesmo com atividade no mesmo instante', async () => {
    const { accountId, owner, in1 } = await setup();
    const made: string[] = [];
    for (let i = 0; i < 9; i++)
      made.push(
        (await inbound(accountId, in1.id, `v${String(i)}`, `m${String(i)}`)).conversationId,
      );
    // força empates de lastActivityAt
    await t.owner.pool.query(
      "update conversations set last_activity_at = '2026-01-01T00:00:00.123Z' where account_id = $1 and display_id in (3,4,5,6)",
      [accountId],
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await listConversations(ctx, owner, {
        limit: 4,
        ...(cursor ? { before: cursor } : {}),
      });
      seen.push(...page.items.map((c) => c.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    expect(new Set(seen)).toEqual(new Set(made));
  });

  it('contadores da barra lateral e não lidas por atendente', async () => {
    const { accountId, a, b, in1 } = await setup();
    const c1 = await inbound(accountId, in1.id, 'v1', 'um');
    await inbound(accountId, in1.id, 'v2', 'dois');
    await inbound(accountId, in1.id, 'v2', 'dois de novo');
    await updateConversation(ctx, a.actor, c1.conversationId, { assigneeId: a.id });
    expect(await conversationCounts(ctx, a.actor)).toEqual({
      all: 2,
      unassigned: 1,
      mine: 1,
      unread: 2,
    });
    const list = (await listConversations(ctx, a.actor)).items;
    expect(list.find((c) => c.id === c1.conversationId)?.unreadCount).toBe(1);
    expect(list.find((c) => c.id !== c1.conversationId)?.unreadCount).toBe(2);
    await markConversationRead(ctx, a.actor, c1.conversationId);
    expect((await conversationCounts(ctx, a.actor)).unread).toBe(1);
    // a leitura é por atendente: o outro continua com 2 não lidas
    expect((await conversationCounts(ctx, b.actor)).unread).toBe(2);
    await sleep(5);
    await inbound(accountId, in1.id, 'v1', 'mais uma');
    expect((await conversationCounts(ctx, a.actor)).unread).toBe(2);
  });

  it('a prévia ignora notas internas; mensagens paginam do fim para o começo', async () => {
    const { accountId, a, in1 } = await setup();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'mensagem 0');
    for (let i = 1; i <= 6; i++) {
      await sleep(3);
      await sendMessage(ctx, a.actor, {
        conversationId,
        content: `mensagem ${String(i)}`,
        clientMessageId: uuidv7(),
      });
    }
    await sleep(3);
    await sendMessage(ctx, a.actor, {
      conversationId,
      content: 'NOTA secreta',
      private: true,
      clientMessageId: uuidv7(),
    });
    const conv = (await listConversations(ctx, a.actor)).items[0];
    expect(conv?.lastMessage).toBe('mensagem 6');
    const p1 = await listMessages(ctx, a.actor, conversationId, { limit: 3 });
    const p2 = await listMessages(ctx, a.actor, conversationId, {
      limit: 3,
      ...(p1.nextCursor ? { before: p1.nextCursor } : {}),
    });
    const p3 = await listMessages(ctx, a.actor, conversationId, {
      limit: 3,
      ...(p2.nextCursor ? { before: p2.nextCursor } : {}),
    });
    const all = [...p1.items, ...p2.items, ...p3.items].map((m) => m.content);
    expect(all).toEqual([
      'NOTA secreta',
      'mensagem 6',
      'mensagem 5',
      'mensagem 4',
      'mensagem 3',
      'mensagem 2',
      'mensagem 1',
      'mensagem 0',
    ]);
    expect(p3.nextCursor).toBeNull();
    await expectCode(
      listMessages(ctx, a.actor, conversationId, { before: 'lixo' }),
      'invalid_input',
    );
  });
});

describe('atualização de conversas, labels e respostas prontas', () => {
  it('status, prioridade, atribuição e adiamento com regras e eventos', async () => {
    const { accountId, owner, a, b, in1, in2 } = await setup();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    const upd = await updateConversation(ctx, a.actor, conversationId, {
      priority: 'high',
      assigneeId: a.id,
    });
    expect(upd).toMatchObject({ priority: 'high', assigneeId: a.id });

    await expectCode(
      updateConversation(ctx, a.actor, conversationId, { status: 'snoozed' }),
      'invalid_input',
    );
    await expectCode(
      updateConversation(ctx, a.actor, conversationId, {
        status: 'snoozed',
        snoozedUntil: new Date(Date.now() - 1000),
      }),
      'invalid_input',
    );
    const until = new Date(Date.now() + 3_600_000);
    const snoozed = await updateConversation(ctx, a.actor, conversationId, {
      status: 'snoozed',
      snoozedUntil: until,
    });
    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozedUntil?.getTime()).toBe(until.getTime());
    const resolved = await updateConversation(ctx, a.actor, conversationId, { status: 'resolved' });
    expect(resolved).toMatchObject({ status: 'resolved', snoozedUntil: null });
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await updateConversation(ctx, a.actor, conversationId, { status: 'open' });
    expect(reopened.resolvedAt).toBeNull();

    // responsável precisa ser membro da inbox (o agente A não é da inbox 2)
    const c2 = await inbound(accountId, in2.id, 'v2', 'oi');
    await expectCode(
      updateConversation(ctx, owner, c2.conversationId, { assigneeId: a.id }),
      'invalid_input',
    );
    await updateConversation(ctx, owner, c2.conversationId, { assigneeId: b.id });
    await expectCode(
      updateConversation(ctx, a.actor, conversationId, { priority: 'urgentissima' as never }),
      'invalid_input',
    );

    const events = await t.owner.pool.query(
      "select payload->'fields' as f from outbox where event_type = 'conversation.updated' and aggregate_id = $1 order by account_seq",
      [conversationId],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(4);
  });

  it('atualização sem mudança real não gera evento', async () => {
    const { accountId, a, in1 } = await setup();
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    const before = await t.owner.pool.query(
      "select count(*)::int as n from outbox where event_type = 'conversation.updated' and account_id = $1",
      [accountId],
    );
    await updateConversation(ctx, a.actor, conversationId, { status: 'open', priority: 'none' });
    const after = await t.owner.pool.query(
      "select count(*)::int as n from outbox where event_type = 'conversation.updated' and account_id = $1",
      [accountId],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('labels: só quem tem labels:manage cria; aplicar/remover é idempotente e só uma vez gera evento', async () => {
    const { accountId, owner, a, in1 } = await setup();
    await expectCode(createLabel(ctx, a.actor, { name: 'vip' }), 'forbidden');
    const label = await createLabel(ctx, owner, { name: 'vip', color: '#00ff00' });
    await expectCode(createLabel(ctx, owner, { name: 'vip' }), 'name_taken');
    await expectCode(createLabel(ctx, owner, { name: 'ruim', color: 'verde' }), 'invalid_input');
    const { conversationId } = await inbound(accountId, in1.id, 'v1', 'oi');
    await addLabel(ctx, a.actor, conversationId, label.id);
    await addLabel(ctx, a.actor, conversationId, label.id);
    expect((await getConversation(ctx, a.actor, conversationId)).labels.map((l) => l.name)).toEqual(
      ['vip'],
    );
    await removeLabel(ctx, a.actor, conversationId, label.id);
    await removeLabel(ctx, a.actor, conversationId, label.id);
    expect((await getConversation(ctx, a.actor, conversationId)).labels).toEqual([]);
    const ev = await t.owner.pool.query(
      "select count(*)::int as n from outbox where event_type = 'conversation.updated' and payload->'fields' ? 'labels' and aggregate_id = $1",
      [conversationId],
    );
    expect(ev.rows[0].n).toBe(2); // 1 adição + 1 remoção efetivas
    await expectCode(addLabel(ctx, a.actor, conversationId, uuidv7()), 'not_found');
  });

  it('respostas prontas: atalho único, busca por prefixo, edição e exclusão', async () => {
    const { a, owner } = await setup();
    const hi = await createCannedResponse(ctx, a.actor, {
      shortcut: ' Ola ',
      content: 'Olá! Como posso ajudar?',
    });
    expect(hi.shortcut).toBe('ola'); // normalizado
    await createCannedResponse(ctx, owner, { shortcut: 'obrigado', content: 'Por nada!' });
    await expectCode(
      createCannedResponse(ctx, a.actor, { shortcut: 'ola', content: 'outra' }),
      'name_taken',
    );
    await expectCode(
      createCannedResponse(ctx, a.actor, { shortcut: 'tem espaço', content: 'x' }),
      'invalid_input',
    );
    expect((await listCannedResponses(ctx, a.actor, 'ol')).map((c) => c.shortcut)).toEqual(['ola']);
    expect((await listCannedResponses(ctx, a.actor, 'por nada')).map((c) => c.shortcut)).toEqual([
      'obrigado',
    ]);
    expect((await listCannedResponses(ctx, a.actor)).map((c) => c.shortcut)).toEqual([
      'obrigado',
      'ola',
    ]);
    expect((await updateCannedResponse(ctx, a.actor, hi.id, { content: 'Oi!' })).content).toBe(
      'Oi!',
    );
    await deleteCannedResponse(ctx, a.actor, hi.id);
    await expectCode(deleteCannedResponse(ctx, a.actor, hi.id), 'not_found');
  });
});
