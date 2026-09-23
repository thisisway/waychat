import { randomBytes } from 'node:crypto';
import { schema, withTenant } from '@waychat/db';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx, type Ctx } from './context.js';
import { DomainError, type DomainErrorCode } from './errors.js';
import {
  addMember,
  authenticate,
  createApiKey,
  createContact,
  createInbox,
  deleteContact,
  deleteInbox,
  findOrCreateContactByIdentity,
  getContact,
  listApiKeys,
  listContacts,
  listInboxes,
  listInboxMembers,
  login,
  registerAccount,
  revokeApiKey,
  rotateIdentitySecret,
  setInboxMembers,
  updateContact,
  updateInbox,
  verifyApiKey,
  type Actor,
} from './index.js';

let t: TestDb;
let clock = Date.UTC(2026, 0, 15, 12, 0, 0);
let ctx: Ctx;
const step = (s: number) => (clock += s * 1000);
const PASSWORD = 'uma-senha-bem-longa-42';
/** O segredo é base64url e pode conter `_`: não dá para separar a chave por `_`. Formato fixo: wc_ + 8 hex + _ + segredo. */
const secretOf = (key: string) => key.slice(12);
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;

async function expectCode(p: Promise<unknown>, code: DomainErrorCode) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
}

async function newAccount(name = 'Acme') {
  const email = `dono-${uniq()}@exemplo.com`;
  const r = await registerAccount(ctx, {
    accountName: name,
    ownerName: 'Dono',
    email,
    password: PASSWORD,
  });
  return { ...r, email };
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

/** Conta com dono e um agente (papel Agente). */
async function accountWithAgent() {
  const acc = await newAccount();
  const owner = await actorOf(acc.email);
  const agentEmail = `agente-${uniq()}@exemplo.com`;
  const { userId } = await addMember(ctx, owner, {
    email: agentEmail,
    name: 'Ana',
    password: PASSWORD,
    roleId: await roleId(acc.accountId, 'Agente'),
  });
  const agent = await actorOf(agentEmail);
  return { ...acc, owner, agent, agentId: userId };
}

beforeAll(async () => {
  t = await startTestDb();
  ctx = createCtx(
    t.app.db,
    {
      sessionSecret: 'x'.repeat(48),
      masterKey: randomBytes(32).toString('base64'),
      masterKeyPrevious: [],
      accessTtlSeconds: 600,
      refreshTtlSeconds: 30 * 86400,
      challengeTtlSeconds: 300,
      issuer: 'WayChat',
    },
    () => new Date(clock),
  );
});

afterAll(async () => {
  await t.stop();
});

describe('inboxes', () => {
  it('widget: cria com segredo de identidade devolvido uma vez; no banco só existe cifrado', async () => {
    const { owner } = await accountWithAgent();
    const { inbox, identitySecret } = await createInbox(ctx, owner, {
      name: 'Site',
      channelType: 'widget',
      welcomeMessage: 'Oi!',
      primaryColor: '#1560ff',
      allowedOrigins: ['https://loja.exemplo.com'],
    });
    expect(identitySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inbox.publicKey.startsWith('ibx_')).toBe(true);
    expect(inbox.welcomeMessage).toBe('Oi!');
    const raw = await t.owner.pool.query('select config_encrypted from inboxes where id = $1', [
      inbox.id,
    ]);
    const stored = raw.rows[0].config_encrypted as string;
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain(identitySecret ?? 'x');
    expect(stored).not.toContain('loja.exemplo.com');
    // a listagem nunca devolve o segredo
    const listed = await listInboxes(ctx, owner);
    expect(JSON.stringify(listed)).not.toContain(identitySecret ?? 'x');
  });

  it('canal API não tem segredo de identidade', async () => {
    const { owner } = await accountWithAgent();
    const r = await createInbox(ctx, owner, { name: 'Integração', channelType: 'api' });
    expect(r.identitySecret).toBeNull();
    await expectCode(rotateIdentitySecret(ctx, owner, r.inbox.id), 'invalid_input');
  });

  it('só quem tem inboxes:manage cria/edita; agente vê só as inboxes de que é membro', async () => {
    const { owner, agent, agentId } = await accountWithAgent();
    await expectCode(createInbox(ctx, agent, { name: 'Nao', channelType: 'api' }), 'forbidden');
    const a = await createInbox(ctx, owner, { name: 'Vendas', channelType: 'widget' });
    const b = await createInbox(ctx, owner, { name: 'Suporte', channelType: 'widget' });
    expect(await listInboxes(ctx, agent)).toHaveLength(0);
    await setInboxMembers(ctx, owner, b.inbox.id, [agentId]);
    expect((await listInboxes(ctx, agent)).map((i) => i.id)).toEqual([b.inbox.id]);
    expect((await listInboxes(ctx, owner)).map((i) => i.id).sort()).toEqual(
      [a.inbox.id, b.inbox.id].sort(),
    );
    await expectCode(updateInbox(ctx, agent, b.inbox.id, { name: 'Hack' }), 'forbidden');
  });

  it('membros: só gente da própria conta; a lista é substituída', async () => {
    const one = await accountWithAgent();
    const two = await accountWithAgent();
    const { inbox } = await createInbox(ctx, one.owner, { name: 'Vendas', channelType: 'api' });
    await expectCode(setInboxMembers(ctx, one.owner, inbox.id, [two.agentId]), 'not_a_member');
    await setInboxMembers(ctx, one.owner, inbox.id, [one.agentId]);
    expect((await listInboxMembers(ctx, one.owner, inbox.id)).map((m) => m.userId)).toEqual([
      one.agentId,
    ]);
    await setInboxMembers(ctx, one.owner, inbox.id, []);
    expect(await listInboxMembers(ctx, one.owner, inbox.id)).toHaveLength(0);
  });

  it('rotacionar o segredo troca o valor; editar mantém o segredo e o resto da config', async () => {
    const { owner } = await accountWithAgent();
    const { inbox, identitySecret } = await createInbox(ctx, owner, {
      name: 'Site',
      channelType: 'widget',
      welcomeMessage: 'Oi',
    });
    const upd = await updateInbox(ctx, owner, inbox.id, {
      welcomeMessage: null,
      primaryColor: '#000000',
      enabled: false,
    });
    expect(upd).toMatchObject({ welcomeMessage: null, primaryColor: '#000000', enabled: false });
    const rotated = await rotateIdentitySecret(ctx, owner, inbox.id);
    expect(rotated.identitySecret).not.toBe(identitySecret);
    // a config continua legível depois das duas cifragens
    expect((await listInboxes(ctx, owner)).find((i) => i.id === inbox.id)?.primaryColor).toBe(
      '#000000',
    );
  });

  it('nome repetido na conta é recusado; entrada inválida também', async () => {
    const { owner } = await accountWithAgent();
    await createInbox(ctx, owner, { name: 'Vendas', channelType: 'api' });
    await expectCode(createInbox(ctx, owner, { name: 'Vendas', channelType: 'api' }), 'name_taken');
    await expectCode(createInbox(ctx, owner, { name: 'x', channelType: 'api' }), 'invalid_input');
    await expectCode(
      createInbox(ctx, owner, { name: 'Ok', channelType: 'telegram' }),
      'invalid_input',
    );
    await expectCode(
      createInbox(ctx, owner, { name: 'Ok2', channelType: 'widget', primaryColor: 'vermelho' }),
      'invalid_input',
    );
  });

  it('não exclui inbox com conversas; exclui a vazia', async () => {
    const { owner, accountId } = await accountWithAgent();
    const used = await createInbox(ctx, owner, { name: 'Com conversa', channelType: 'api' });
    const empty = await createInbox(ctx, owner, { name: 'Vazia', channelType: 'api' });
    const contact = await createContact(ctx, owner, { name: 'Cliente' });
    await withTenant(t.app.db, accountId, (tx) =>
      tx
        .insert(schema.conversations)
        .values({ accountId, inboxId: used.inbox.id, contactId: contact.id }),
    );
    await expectCode(deleteInbox(ctx, owner, used.inbox.id), 'inbox_in_use');
    await deleteInbox(ctx, owner, empty.inbox.id);
    expect((await listInboxes(ctx, owner)).map((i) => i.id)).toEqual([used.inbox.id]);
  });

  it('isolamento: a inbox de uma conta é invisível e intocável para outra', async () => {
    const a = await accountWithAgent();
    const b = await accountWithAgent();
    const { inbox } = await createInbox(ctx, a.owner, { name: 'Privada', channelType: 'api' });
    expect(await listInboxes(ctx, b.owner)).toHaveLength(0);
    await expectCode(updateInbox(ctx, b.owner, inbox.id, { name: 'Sequestrada' }), 'not_found');
    await expectCode(deleteInbox(ctx, b.owner, inbox.id), 'not_found');
  });
});

describe('chaves de API', () => {
  it('cria (texto mostrado uma vez), guarda só o hash, lista sem segredo e autentica', async () => {
    const { owner, accountId } = await accountWithAgent();
    const { key, apiKey } = await createApiKey(ctx, owner, {
      name: 'CRM',
      scopes: ['messages:write'],
    });
    expect(key).toMatch(/^wc_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const secret = secretOf(key);
    const row = await t.owner.pool.query(
      'select key_prefix, key_hash from api_keys where id = $1',
      [apiKey.id],
    );
    expect(row.rows[0].key_hash).not.toContain(secret);
    expect(row.rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/); // SHA-256
    expect(JSON.stringify(await listApiKeys(ctx, owner))).not.toContain(secret);

    const principal = await verifyApiKey(ctx, key);
    expect(principal.accountId).toBe(accountId);
    expect(principal.scopes.has('messages:write')).toBe(true);
    expect(principal.scopes.has('contacts:write')).toBe(false);
  });

  it('toda falha dá o mesmo erro: formato, prefixo inexistente, segredo errado, revogada, expirada', async () => {
    const { owner } = await accountWithAgent();
    const { key } = await createApiKey(ctx, owner, {
      name: 'Temp',
      scopes: ['messages:write'],
      expiresAt: new Date(clock + 3_600_000),
    });
    const prefix = key.slice(3, 11);
    const secret = secretOf(key);
    await expectCode(verifyApiKey(ctx, 'lixo'), 'api_key_invalid');
    await expectCode(verifyApiKey(ctx, `wc_${'0'.repeat(8)}_${secret}`), 'api_key_invalid');
    await expectCode(verifyApiKey(ctx, `wc_${prefix}_${'A'.repeat(43)}`), 'api_key_invalid');
    await verifyApiKey(ctx, key);
    step(3_601); // passou da expiração
    await expectCode(verifyApiKey(ctx, key), 'api_key_invalid');

    const second = await createApiKey(ctx, owner, { name: 'Outra', scopes: ['messages:write'] });
    await verifyApiKey(ctx, second.key);
    await revokeApiKey(ctx, owner, second.apiKey.id);
    await expectCode(verifyApiKey(ctx, second.key), 'api_key_invalid');
  });

  it('a chave da conta A nunca resolve para a conta B', async () => {
    const a = await accountWithAgent();
    const b = await accountWithAgent();
    const ka = await createApiKey(ctx, a.owner, { name: 'Chave A', scopes: ['messages:write'] });
    const kb = await createApiKey(ctx, b.owner, { name: 'Chave B', scopes: ['messages:write'] });
    expect((await verifyApiKey(ctx, ka.key)).accountId).toBe(a.accountId);
    expect((await verifyApiKey(ctx, kb.key)).accountId).toBe(b.accountId);
    // prefixo de uma com segredo da outra não passa
    const mixed = `wc_${ka.key.slice(3, 11)}_${secretOf(kb.key)}`;
    await expectCode(verifyApiKey(ctx, mixed), 'api_key_invalid');
    await expectCode(revokeApiKey(ctx, b.owner, ka.apiKey.id), 'not_found');
  });

  it('agente não gerencia chaves; escopo e expiração inválidos são recusados; last_used é limitado a 1 gravação/min', async () => {
    const { owner, agent } = await accountWithAgent();
    await expectCode(
      createApiKey(ctx, agent, { name: 'Nao', scopes: ['messages:write'] }),
      'forbidden',
    );
    await expectCode(
      createApiKey(ctx, owner, { name: 'Ruim', scopes: ['admin:tudo'] }),
      'invalid_input',
    );
    await expectCode(
      createApiKey(ctx, owner, {
        name: 'Passado',
        scopes: ['messages:write'],
        expiresAt: new Date(clock - 1000),
      }),
      'invalid_input',
    );

    const { key, apiKey } = await createApiKey(ctx, owner, {
      name: 'Uso',
      scopes: ['messages:write'],
    });
    await verifyApiKey(ctx, key);
    const first = (
      await t.owner.pool.query('select last_used_at from api_keys where id = $1', [apiKey.id])
    ).rows[0].last_used_at as Date;
    step(10);
    await verifyApiKey(ctx, key);
    const second = (
      await t.owner.pool.query('select last_used_at from api_keys where id = $1', [apiKey.id])
    ).rows[0].last_used_at as Date;
    expect(second.getTime()).toBe(first.getTime()); // dentro de 1 min: sem novo UPDATE
    step(70);
    await verifyApiKey(ctx, key);
    const third = (
      await t.owner.pool.query('select last_used_at from api_keys where id = $1', [apiKey.id])
    ).rows[0].last_used_at as Date;
    expect(third.getTime()).toBeGreaterThan(first.getTime());
  });
});

describe('contatos', () => {
  it('normaliza e-mail e telefone; recusa dados inválidos', async () => {
    const { owner } = await accountWithAgent();
    const c = await createContact(ctx, owner, {
      name: '  Maria Souza  ',
      email: ' MARIA@Exemplo.COM ',
      phone: '(11) 90000-0000',
    });
    expect(c).toMatchObject({
      name: 'Maria Souza',
      email: 'maria@exemplo.com',
      phone: '11900000000',
    });
    const intl = await createContact(ctx, owner, { name: 'Intl', phone: '+55 11 90000-0001' });
    expect(intl.phone).toBe('+5511900000001');
    await expectCode(createContact(ctx, owner, { name: '' }), 'invalid_input');
    await expectCode(
      createContact(ctx, owner, { name: 'X', email: 'nao-e-email' }),
      'invalid_input',
    );
    await expectCode(createContact(ctx, owner, { name: 'X', phone: '123' }), 'invalid_input');
    await expectCode(
      createContact(ctx, owner, { name: 'X', attributes: { a: { aninhado: 1 } } }),
      'invalid_input',
    );
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${String(i)}`, 'v']));
    await expectCode(createContact(ctx, owner, { name: 'X', attributes: many }), 'invalid_input');
  });

  it('busca parcial por nome, e-mail e telefone; caracteres especiais são literais', async () => {
    const { owner } = await accountWithAgent();
    await createContact(ctx, owner, {
      name: 'Brandon Madsen',
      email: 'm.brandon@gmail.com',
      phone: '+5543712345678',
    });
    await createContact(ctx, owner, { name: 'Loren Quigley' });
    await createContact(ctx, owner, { name: '100% Desconto_Loja' });
    const names = async (q: string) =>
      (await listContacts(ctx, owner, { search: q })).items.map((c) => c.name);
    expect(await names('brand')).toEqual(['Brandon Madsen']);
    expect(await names('gmail')).toEqual(['Brandon Madsen']);
    expect(await names('437123')).toEqual(['Brandon Madsen']);
    expect(await names('QUIGLEY')).toEqual(['Loren Quigley']);
    expect(await names('100%')).toEqual(['100% Desconto_Loja']); // % não vira curinga
    expect(await names('%')).toEqual(['100% Desconto_Loja']);
    expect(await names('inexistente')).toEqual([]);
  });

  it('pagina por cursor sem repetir, do mais novo para o mais antigo', async () => {
    const { owner } = await accountWithAgent();
    for (let i = 0; i < 7; i++) await createContact(ctx, owner, { name: `Contato ${String(i)}` });
    const p1 = await listContacts(ctx, owner, { limit: 3 });
    const p2 = await listContacts(ctx, owner, {
      limit: 3,
      ...(p1.nextCursor ? { before: p1.nextCursor } : {}),
    });
    const p3 = await listContacts(ctx, owner, {
      limit: 3,
      ...(p2.nextCursor ? { before: p2.nextCursor } : {}),
    });
    const all = [...p1.items, ...p2.items, ...p3.items].map((c) => c.name);
    expect(all).toEqual(Array.from({ length: 7 }, (_, i) => `Contato ${String(6 - i)}`));
    expect(p3.nextCursor).toBeNull();
  });

  it('atualiza, aplica permissões e isola entre contas', async () => {
    const a = await accountWithAgent();
    const b = await accountWithAgent();
    const c = await createContact(ctx, a.agent, { name: 'Do agente' }); // agente pode gerenciar contatos
    const upd = await updateContact(ctx, a.owner, c.id, {
      name: 'Renomeado',
      email: null,
      attributes: { plano: 'pro', vip: true },
    });
    expect(upd).toMatchObject({
      name: 'Renomeado',
      email: null,
      attributes: { plano: 'pro', vip: true },
    });
    expect((await getContact(ctx, a.agent, c.id)).name).toBe('Renomeado');
    await expectCode(getContact(ctx, b.owner, c.id), 'not_found');
    await expectCode(updateContact(ctx, b.owner, c.id, { name: 'X' }), 'not_found');
    await expectCode(deleteContact(ctx, b.owner, c.id), 'not_found');
    expect((await listContacts(ctx, b.owner)).items).toHaveLength(0);
  });

  it('exclui o contato sem conversas e recusa o que tem conversas', async () => {
    const { owner, accountId } = await accountWithAgent();
    const { inbox } = await createInbox(ctx, owner, { name: 'X1', channelType: 'api' });
    const withConv = await createContact(ctx, owner, { name: 'Tem conversa' });
    const free = await createContact(ctx, owner, { name: 'Livre' });
    await withTenant(t.app.db, accountId, (tx) =>
      tx
        .insert(schema.conversations)
        .values({ accountId, inboxId: inbox.id, contactId: withConv.id }),
    );
    await expectCode(deleteContact(ctx, owner, withConv.id), 'contact_in_use');
    await deleteContact(ctx, owner, free.id);
    await expectCode(getContact(ctx, owner, free.id), 'not_found');
  });

  it('eventos só carregam ids (nada de dados pessoais) e a exclusão é auditada', async () => {
    const { owner, accountId } = await accountWithAgent();
    const c = await createContact(ctx, owner, {
      name: 'Pessoa Secreta',
      email: 'secreta@exemplo.com',
      phone: '+5511999990000',
    });
    await deleteContact(ctx, owner, c.id);
    const events = await withTenant(t.app.db, accountId, (tx) =>
      tx.select().from(schema.outbox).where(eq(schema.outbox.aggregateId, c.id)),
    );
    expect(events.map((e) => e.eventType).sort()).toEqual(['contact.created', 'contact.deleted']);
    const dump = JSON.stringify(events.map((e) => e.payload));
    expect(dump).not.toContain('Secreta');
    expect(dump).not.toContain('secreta@');
    expect(dump).not.toContain('5511999990000');
    const audit = await withTenant(t.app.db, accountId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, 'contact.deleted')),
    );
    expect(audit).toHaveLength(1);
  });
});

describe('identidade de canal -> contato', () => {
  it('é idempotente: a mesma identidade devolve o mesmo contato', async () => {
    const { accountId } = await accountWithAgent();
    const id = { channel: 'widget', externalId: `visitor-${uniq()}`, name: 'Visitante' };
    const first = await withTenant(t.app.db, accountId, (tx) =>
      findOrCreateContactByIdentity(tx, accountId, id),
    );
    const second = await withTenant(t.app.db, accountId, (tx) =>
      findOrCreateContactByIdentity(tx, accountId, id),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ contactId: first.contactId, created: false });
  });

  it('10 chegadas simultâneas da mesma identidade criam UM contato', async () => {
    const { accountId } = await accountWithAgent();
    const id = { channel: 'whatsapp', externalId: `wa-${uniq()}`, name: 'Cliente' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withTenant(t.app.db, accountId, (tx) => findOrCreateContactByIdentity(tx, accountId, id)),
      ),
    );
    expect(new Set(results.map((r) => r.contactId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const rows = await t.owner.pool.query(
      'select count(*)::int as n from contacts where account_id = $1 and name = $2',
      [accountId, 'Cliente'],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('a mesma identidade em contas diferentes gera contatos diferentes', async () => {
    const a = await accountWithAgent();
    const b = await accountWithAgent();
    const id = { channel: 'widget', externalId: `same-${uniq()}`, name: 'Igual' };
    const ra = await withTenant(t.app.db, a.accountId, (tx) =>
      findOrCreateContactByIdentity(tx, a.accountId, id),
    );
    const rb = await withTenant(t.app.db, b.accountId, (tx) =>
      findOrCreateContactByIdentity(tx, b.accountId, id),
    );
    expect(ra.contactId).not.toBe(rb.contactId);
  });
});
