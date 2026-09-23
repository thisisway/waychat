import { randomBytes } from 'node:crypto';
import { schema, withTenant } from '@waychat/db';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { and, eq, isNull } from 'drizzle-orm';
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import { generateSync } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCtx, type Ctx } from './context.js';
import { DomainError, type DomainErrorCode } from './errors.js';
import {
  addMember,
  authenticate,
  beginTotpEnrollment,
  changeMemberRole,
  createRole,
  deleteRole,
  listMembers,
  listRoles,
  removeMember,
  updateRole,
  completeEnrollmentLogin,
  completeMfaLogin,
  confirmTotpEnrollment,
  login,
  logout,
  refreshSession,
  registerAccount,
  verifyChallenge,
} from './index.js';

let t: TestDb;
let clock = Date.UTC(2026, 0, 15, 12, 0, 0);
let ctx: Ctx;
const step = (seconds: number) => (clock += seconds * 1000);
const totp = (secret: string, offset = 0) =>
  generateSync({ secret, epoch: Math.floor(clock / 1000) + offset });

const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;

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

async function loginOk(email: string, password = PASSWORD) {
  const r = await login(ctx, { email, password, ip: '203.0.113.7', userAgent: 'vitest' });
  if (r.status !== 'authenticated') throw new Error(`esperava authenticated, veio ${r.status}`);
  return r;
}

async function expectCode(p: Promise<unknown>, code: DomainErrorCode) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DomainError);
  expect((err as DomainError).code).toBe(code);
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

describe('registro de conta', () => {
  it('cria conta, 4 papéis de sistema, Owner, auditoria e evento no outbox', async () => {
    const { accountId, userId } = await newAccount();
    const roles = await withTenant(t.app.db, accountId, (tx) => tx.select().from(schema.roles));
    expect(roles.map((r) => r.name).sort()).toEqual(['Admin', 'Agente', 'Owner', 'Supervisor']);
    expect(roles.every((r) => r.isSystem)).toBe(true);

    const audit = await withTenant(t.app.db, accountId, (tx) => tx.select().from(schema.auditLogs));
    expect(audit.map((a) => a.action)).toContain('account.created');
    const ob = await withTenant(t.app.db, accountId, (tx) => tx.select().from(schema.outbox));
    expect(ob[0]).toMatchObject({ eventType: 'account.created', aggregateId: accountId });
    expect(ob[0]?.payload).toMatchObject({ owner_user_id: userId });
  });

  it('a senha nunca fica em claro', async () => {
    const { userId } = await newAccount();
    const [u] = await t.owner.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(u?.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(u?.passwordHash).not.toContain(PASSWORD);
  });

  it('rejeita e-mail repetido (sem diferenciar maiúsculas), senha fraca', async () => {
    const { email } = await newAccount();
    await expectCode(
      registerAccount(ctx, {
        accountName: 'X',
        ownerName: 'Y',
        email: email.toUpperCase(),
        password: PASSWORD,
      }),
      'email_taken',
    );
    await expectCode(
      registerAccount(ctx, {
        accountName: 'X',
        ownerName: 'Y',
        email: `a-${uniq()}@e.com`,
        password: 'curta',
      }),
      'weak_password',
    );
  });

  it('rollback total quando falha no meio: nada de conta órfã', async () => {
    const { email } = await newAccount();
    const before = await t.owner.pool.query('select count(*)::int as n from accounts');
    await expectCode(
      registerAccount(ctx, { accountName: 'Órfã', ownerName: 'Y', email, password: PASSWORD }),
      'email_taken',
    );
    const after = await t.owner.pool.query('select count(*)::int as n from accounts');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('login e bloqueio', () => {
  it('login válido devolve tokens e authenticate carrega as permissões', async () => {
    const { email, accountId, userId } = await newAccount();
    const r = await loginOk(email);
    expect(r.accountId).toBe(accountId);
    const actor = await authenticate(ctx, r.tokens.accessToken);
    expect(actor).toMatchObject({ userId, accountId, mfaVerified: false });
    expect(actor.permissions.has('members:manage')).toBe(true);
  });

  it('e-mail inexistente e senha errada dão o MESMO erro; e-mail vira só hash na auditoria', async () => {
    const { email } = await newAccount();
    const ghost = `fantasma-${uniq()}@exemplo.com`;
    await expectCode(login(ctx, { email: ghost, password: PASSWORD }), 'invalid_credentials');
    await expectCode(login(ctx, { email, password: 'senha-errada-123' }), 'invalid_credentials');
    const audit = await t.owner.pool.query(
      `select metadata::text as m from audit_logs where action = 'login.failed'`,
    );
    expect(audit.rows.some((r: { m: string }) => r.m.includes(ghost))).toBe(false);
    expect(audit.rows.some((r: { m: string }) => r.m.includes('unknown_user'))).toBe(true);
  });

  it('bloqueia na 5ª falha, recusa até a senha certa durante o bloqueio e libera depois', async () => {
    const { email } = await newAccount();
    for (let i = 0; i < 5; i++) {
      await expectCode(
        login(ctx, { email, password: `errada-${String(i)}-xxxxx` }),
        'invalid_credentials',
      );
    }
    await expectCode(login(ctx, { email, password: PASSWORD }), 'invalid_credentials'); // bloqueado
    step(31);
    const r = await loginOk(email); // 30 s depois
    expect(r.status).toBe('authenticated');
    // sucesso zera o contador: mais 4 falhas não bloqueiam
    for (let i = 0; i < 4; i++)
      await expect(login(ctx, { email, password: 'errada-yyyyyyy' })).rejects.toThrow();
    await loginOk(email);
  });

  it('access token expira, mas o refresh continua funcionando', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    step(601);
    await expectCode(authenticate(ctx, tokens.accessToken), 'invalid_token');
    const fresh = await refreshSession(ctx, tokens.refreshToken);
    await authenticate(ctx, fresh.accessToken);
  });

  it('token adulterado, ou challenge usado como access token, é recusado', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    const [h, p] = tokens.accessToken.split('.');
    await expectCode(authenticate(ctx, `${h ?? ''}.${p ?? ''}.assinatura-falsa`), 'invalid_token');
    await expectCode(authenticate(ctx, 'lixo'), 'invalid_token');
  });
});

describe('sessões e refresh rotativo', () => {
  it('rotaciona: o refresh novo funciona e o antigo deixa de valer', async () => {
    const { email } = await newAccount();
    const { tokens: a } = await loginOk(email);
    const b = await refreshSession(ctx, a.refreshToken);
    expect(b.refreshToken).not.toBe(a.refreshToken);
    const c = await refreshSession(ctx, b.refreshToken);
    await authenticate(ctx, c.accessToken);
  });

  it('REUSO de refresh já rotacionado revoga a família inteira e audita', async () => {
    const { email, accountId } = await newAccount();
    const { tokens: a } = await loginOk(email);
    const b = await refreshSession(ctx, a.refreshToken);
    await expectCode(refreshSession(ctx, a.refreshToken), 'invalid_token'); // atacante reapresenta o antigo
    await expectCode(refreshSession(ctx, b.refreshToken), 'invalid_token'); // o legítimo também cai
    await expectCode(authenticate(ctx, b.accessToken), 'invalid_token'); // e o access token da família
    const audit = await withTenant(t.app.db, accountId, (tx) =>
      tx
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'session.refresh_reuse_detected')),
    );
    expect(audit.length).toBeGreaterThan(0);
  });

  it('duas rotações simultâneas do mesmo token: só uma vence, a outra é tratada como reuso', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    const results = await Promise.allSettled([
      refreshSession(ctx, tokens.refreshToken),
      refreshSession(ctx, tokens.refreshToken),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('refresh vencido é recusado', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    step(31 * 86400);
    await expectCode(refreshSession(ctx, tokens.refreshToken), 'invalid_token');
  });

  it('o refresh token só existe em hash no banco', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    const r = await t.owner.pool.query('select refresh_hash from sessions');
    expect(
      r.rows.some((row: { refresh_hash: string }) => row.refresh_hash === tokens.refreshToken),
    ).toBe(false);
  });

  it('logout invalida access e refresh', async () => {
    const { email } = await newAccount();
    const { tokens } = await loginOk(email);
    const actor = await authenticate(ctx, tokens.accessToken);
    await logout(ctx, actor);
    await expectCode(authenticate(ctx, tokens.accessToken), 'invalid_token');
    await expectCode(refreshSession(ctx, tokens.refreshToken), 'invalid_token');
  });
});

describe('2FA (TOTP)', () => {
  async function enrolledUser() {
    const acc = await newAccount();
    const { secret } = await beginTotpEnrollment(ctx, acc.userId);
    const { recoveryCodes } = await confirmTotpEnrollment(ctx, acc.userId, totp(secret));
    return { ...acc, secret, recoveryCodes };
  }

  it('cadastro: segredo cifrado no banco, 10 códigos de recuperação só em hash', async () => {
    const { userId, secret, recoveryCodes } = await enrolledUser();
    expect(recoveryCodes).toHaveLength(10);
    const f = await t.owner.pool.query(
      'select secret_encrypted from user_mfa_factors where user_id = $1',
      [userId],
    );
    expect(f.rows[0].secret_encrypted).not.toContain(secret);
    const rc = await t.owner.pool.query(
      'select code_hash from user_recovery_codes where user_id = $1',
      [userId],
    );
    expect(rc.rows).toHaveLength(10);
    expect(rc.rows.some((r: { code_hash: string }) => recoveryCodes.includes(r.code_hash))).toBe(
      false,
    );
  });

  it('código errado no cadastro não ativa o fator', async () => {
    const acc = await newAccount();
    await beginTotpEnrollment(ctx, acc.userId);
    await expectCode(confirmTotpEnrollment(ctx, acc.userId, '000000'), 'invalid_mfa_code');
    const r = await login(ctx, { email: acc.email, password: PASSWORD });
    expect(r.status).toBe('authenticated'); // sem fator confirmado, o login segue sem 2FA
  });

  it('login exige o segundo fator; o mesmo código não vale duas vezes', async () => {
    const u = await enrolledUser();
    step(60); // o passo do cadastro já foi consumido
    const first = await login(ctx, { email: u.email, password: PASSWORD });
    expect(first.status).toBe('mfa_required');
    if (first.status !== 'mfa_required') return;

    const code = totp(u.secret);
    const done = await completeMfaLogin(ctx, { challenge: first.challenge, factor: { code } });
    const actor = await authenticate(ctx, done.tokens.accessToken);
    expect(actor.mfaVerified).toBe(true);

    const again = await login(ctx, { email: u.email, password: PASSWORD });
    if (again.status !== 'mfa_required') throw new Error('esperava mfa_required');
    await expectCode(
      completeMfaLogin(ctx, { challenge: again.challenge, factor: { code } }),
      'invalid_mfa_code',
    );

    step(30); // próximo passo: código novo é aceito
    const ok = await completeMfaLogin(ctx, {
      challenge: again.challenge,
      factor: { code: totp(u.secret) },
    });
    expect(ok.accountId).toBe(u.accountId);
  });

  it('código de recuperação vale uma única vez', async () => {
    const u = await enrolledUser();
    const rc = u.recoveryCodes[0] ?? '';
    const l1 = await login(ctx, { email: u.email, password: PASSWORD });
    if (l1.status !== 'mfa_required') throw new Error('esperava mfa_required');
    await completeMfaLogin(ctx, { challenge: l1.challenge, factor: { recoveryCode: rc } });
    const l2 = await login(ctx, { email: u.email, password: PASSWORD });
    if (l2.status !== 'mfa_required') throw new Error('esperava mfa_required');
    await expectCode(
      completeMfaLogin(ctx, { challenge: l2.challenge, factor: { recoveryCode: rc } }),
      'invalid_mfa_code',
    );
  });

  it('erros de 2FA contam para o bloqueio progressivo', async () => {
    const u = await enrolledUser();
    const l = await login(ctx, { email: u.email, password: PASSWORD });
    if (l.status !== 'mfa_required') throw new Error('esperava mfa_required');
    for (let i = 0; i < 5; i++) {
      await expectCode(
        completeMfaLogin(ctx, { challenge: l.challenge, factor: { code: '111111' } }),
        'invalid_mfa_code',
      );
    }
    // agora até o código certo é recusado (conta bloqueada)
    await expectCode(
      completeMfaLogin(ctx, { challenge: l.challenge, factor: { code: totp(u.secret, 30) } }),
      'invalid_credentials',
    );
  });

  it('o challenge de MFA não vale como access token nem o contrário', async () => {
    const u = await enrolledUser();
    const l = await login(ctx, { email: u.email, password: PASSWORD });
    if (l.status !== 'mfa_required') throw new Error('esperava mfa_required');
    await expectCode(authenticate(ctx, l.challenge), 'invalid_token');
    const { tokens } = await loginOk((await newAccount()).email);
    await expectCode(verifyChallenge(ctx, tokens.accessToken, 'mfa'), 'invalid_token');
    await expectCode(verifyChallenge(ctx, l.challenge, 'enroll'), 'invalid_token'); // finalidade errada
  });

  it('conta que exige 2FA força o cadastro no primeiro login', async () => {
    const acc = await newAccount();
    await withTenant(t.app.db, acc.accountId, (tx) =>
      tx
        .update(schema.accounts)
        .set({ require2fa: true })
        .where(eq(schema.accounts.id, acc.accountId)),
    );
    const l = await login(ctx, { email: acc.email, password: PASSWORD });
    expect(l.status).toBe('mfa_enrollment_required');
    if (l.status !== 'mfa_enrollment_required') return;
    const { secret } = await beginTotpEnrollment(ctx, acc.userId);
    const done = await completeEnrollmentLogin(ctx, { challenge: l.challenge, code: totp(secret) });
    expect(done.recoveryCodes).toHaveLength(10);
    expect((await authenticate(ctx, done.tokens.accessToken)).mfaVerified).toBe(true);
  });
});

describe('RBAC', () => {
  async function actorOf(email: string) {
    const { tokens } = await loginOk(email);
    return authenticate(ctx, tokens.accessToken);
  }
  const roleId = async (accountId: string, name: string) => {
    const [r] = await withTenant(t.app.db, accountId, (tx) =>
      tx.select().from(schema.roles).where(eq(schema.roles.name, name)),
    );
    if (!r) throw new Error(`papel ${name} não existe`);
    return r.id;
  };

  it('Agente não gerencia papéis nem membros (deny-by-default)', async () => {
    const acc = await newAccount();
    const owner = await actorOf(acc.email);
    const email = `agente-${uniq()}@exemplo.com`;
    await addMember(ctx, owner, {
      email,
      name: 'Ana',
      password: PASSWORD,
      roleId: await roleId(acc.accountId, 'Agente'),
    });
    const agent = await actorOf(email);
    await expectCode(createRole(ctx, agent, { name: 'x', permissions: [] }), 'forbidden');
    await expectCode(listMembers(ctx, agent), 'forbidden');
    await expectCode(
      addMember(ctx, agent, {
        email: 'z@z.com',
        name: 'z',
        password: PASSWORD,
        roleId: owner.userId,
      }),
      'forbidden',
    );
  });

  it('anti-escalada: quem só tem roles:manage não cria papel com permissões que não tem', async () => {
    const acc = await newAccount();
    const owner = await actorOf(acc.email);
    const limited = await createRole(ctx, owner, {
      name: 'Gerente de papéis',
      permissions: ['roles:manage', 'roles:read', 'members:manage', 'members:read'],
    });
    const email = `g-${uniq()}@exemplo.com`;
    await addMember(ctx, owner, { email, name: 'G', password: PASSWORD, roleId: limited.id });
    const g = await actorOf(email);

    await expectCode(
      createRole(ctx, g, { name: 'Super', permissions: ['audit:read'] }),
      'privilege_escalation',
    );
    const ok = await createRole(ctx, g, { name: 'Leitor', permissions: ['members:read'] });
    await expectCode(
      updateRole(ctx, g, ok.id, { permissions: ['api_keys:manage'] }),
      'privilege_escalation',
    );
    // e não atribui um papel maior que o seu
    await expectCode(
      changeMemberRole(ctx, g, g.userId, await roleId(acc.accountId, 'Owner')),
      'privilege_escalation',
    );
  });

  it('papéis de sistema são imutáveis; permissão desconhecida é recusada; papel em uso não é apagado', async () => {
    const acc = await newAccount();
    const owner = await actorOf(acc.email);
    await expectCode(
      updateRole(ctx, owner, await roleId(acc.accountId, 'Admin'), { name: 'Outro' }),
      'system_role_immutable',
    );
    await expectCode(
      deleteRole(ctx, owner, await roleId(acc.accountId, 'Agente')),
      'system_role_immutable',
    );
    await expectCode(
      createRole(ctx, owner, { name: 'Ruim', permissions: ['inventado:tudo'] }),
      'invalid_permission',
    );
    const r = await createRole(ctx, owner, { name: 'Custom', permissions: ['members:read'] });
    await addMember(ctx, owner, {
      email: `c-${uniq()}@exemplo.com`,
      name: 'C',
      password: PASSWORD,
      roleId: r.id,
    });
    await expectCode(deleteRole(ctx, owner, r.id), 'role_in_use');
    await expectCode(createRole(ctx, owner, { name: 'Custom', permissions: [] }), 'name_taken');
    expect((await listRoles(ctx, owner)).find((x) => x.id === r.id)?.permissions).toEqual([
      'members:read',
    ]);
  });

  it('a conta nunca fica sem Owner', async () => {
    const acc = await newAccount();
    const owner = await actorOf(acc.email);
    await expectCode(removeMember(ctx, owner, owner.userId), 'last_owner');
    await expectCode(
      changeMemberRole(ctx, owner, owner.userId, await roleId(acc.accountId, 'Agente')),
      'last_owner',
    );
  });

  it('remover membro derruba as sessões dele na hora', async () => {
    const acc = await newAccount();
    const owner = await actorOf(acc.email);
    const email = `m-${uniq()}@exemplo.com`;
    const { userId } = await addMember(ctx, owner, {
      email,
      name: 'M',
      password: PASSWORD,
      roleId: await roleId(acc.accountId, 'Agente'),
    });
    const { tokens } = await loginOk(email);
    await removeMember(ctx, owner, userId);
    await expectCode(authenticate(ctx, tokens.accessToken), 'invalid_token');
    await expectCode(refreshSession(ctx, tokens.refreshToken), 'invalid_token');
    const active = await t.owner.db
      .select()
      .from(schema.sessions)
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)));
    expect(active).toHaveLength(0);
  });

  it('isolamento: o Owner da conta A não enxerga nem usa papéis da conta B', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    const ownerA = await actorOf(a.email);
    const members = await listMembers(ctx, ownerA);
    expect(members.map((m) => m.userId)).toEqual([a.userId]);
    const roleOfB = await roleId(b.accountId, 'Agente');
    await expectCode(
      addMember(ctx, ownerA, {
        email: `x-${uniq()}@exemplo.com`,
        name: 'X',
        password: PASSWORD,
        roleId: roleOfB,
      }),
      'not_found',
    );
  });

  it('usuário existente pode entrar em uma segunda conta e escolher qual usar no login', async () => {
    const a = await newAccount('A');
    const b = await newAccount('B');
    const ownerB = await actorOf(b.email);
    await addMember(ctx, ownerB, {
      email: a.email,
      name: 'A',
      password: 'ignorada-pois-ja-existe',
      roleId: await roleId(b.accountId, 'Agente'),
    });
    const inA = await login(ctx, { email: a.email, password: PASSWORD });
    expect(inA).toMatchObject({ status: 'authenticated', accountId: a.accountId });
    const inB = await login(ctx, { email: a.email, password: PASSWORD, accountId: b.accountId });
    expect(inB).toMatchObject({ status: 'authenticated', accountId: b.accountId });
    // e não dá para escolher uma conta da qual não é membro
    const c = await newAccount('C');
    await expectCode(
      login(ctx, { email: a.email, password: PASSWORD, accountId: c.accountId }),
      'invalid_credentials',
    );
  });
});

describe('trace no outbox', () => {
  it('o evento grava o traceparent da requisição, para o worker continuar o mesmo trace', async () => {
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    try {
      let traceId = '';
      let accountId = '';
      await trace.getTracer('t').startActiveSpan('POST /auth/register', async (span) => {
        traceId = span.spanContext().traceId;
        accountId = (await newAccount()).accountId;
        span.end();
      });
      const [ev] = await withTenant(t.app.db, accountId, (tx) => tx.select().from(schema.outbox));
      expect(ev?.traceContext).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-0[01]$`));
    } finally {
      trace.disable();
      context.disable();
      propagation.disable();
    }
  });

  it('sem tracing ativo o campo fica nulo (custo zero)', async () => {
    const { accountId } = await newAccount();
    const [ev] = await withTenant(t.app.db, accountId, (tx) => tx.select().from(schema.outbox));
    expect(ev?.traceContext).toBeNull();
  });
});
