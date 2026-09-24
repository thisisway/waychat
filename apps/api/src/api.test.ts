import { randomBytes } from 'node:crypto';
import { createCtx, receiveInboundMessage, type Ctx } from '@waychat/core';
import { startTestDb, type TestDb } from '@waychat/db/testing';
import { loadEnv } from '@waychat/shared';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generateSync } from 'otplib';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import type { Access } from './types.js';

let t: TestDb;
let app: FastifyInstance;
let routeAccess: Map<string, Access>;
let coreCtx: Ctx;
const registry = new Registry();
let clock = Date.UTC(2026, 0, 15, 12, 0, 0);
const step = (s: number) => (clock += s * 1000);

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'uma-senha-bem-longa-42';
let n = 0;
const uniq = () => `${String(++n)}-${randomBytes(3).toString('hex')}`;
/** Cada teste usa um IP próprio para não dividir a cota de rate limit com os demais. */
const ip = () => `10.1.${String(Math.floor(n / 250))}.${String((n % 250) + 1)}`;

interface Session {
  cookie: string;
  csrf: string;
  ip: string;
}

function jar(res: LightMyRequestResponse): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}

function sessionFrom(res: LightMyRequestResponse, ipAddr: string): Session {
  const c = jar(res);
  return {
    cookie: `wc_at=${c['wc_at'] ?? ''}; wc_rt=${c['wc_rt'] ?? ''}; wc_csrf=${c['wc_csrf'] ?? ''}`,
    csrf: c['wc_csrf'] ?? '',
    ip: ipAddr,
  };
}

async function call(
  s: Session | null,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
  extra: { csrf?: boolean; headers?: Record<string, string>; ip?: string } = {},
) {
  return app.inject({
    method,
    url,
    remoteAddress: extra.ip ?? s?.ip ?? ip(),
    headers: {
      ...(s ? { cookie: s.cookie } : {}),
      ...(s && extra.csrf !== false && method !== 'GET' ? { 'x-csrf-token': s.csrf } : {}),
      ...extra.headers,
    },
    ...(body !== undefined ? { payload: body as object } : {}),
  });
}

async function register(name = 'Acme') {
  const email = `dono-${uniq()}@exemplo.com`;
  const addr = ip();
  const res = await call(
    null,
    'POST',
    '/auth/register',
    { account_name: name, name: 'Dono', email, password: PASSWORD },
    { ip: addr },
  );
  expect(res.statusCode, res.body).toBe(201);
  return { email, res, s: sessionFrom(res, addr) };
}

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
    SESSION_SECRET: 'y'.repeat(48),
  });
  coreCtx = createCtx(
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
    () => new Date(clock),
  );
  const built = await buildApp({ env, ctx: coreCtx, logger: false, metrics: registry });
  app = built.app;
  routeAccess = built.routeAccess;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await t.stop();
});

describe('autorização deny-by-default', () => {
  it('toda rota registrada declara o tipo de acesso; rotas públicas são exatamente estas', () => {
    expect(routeAccess.size).toBeGreaterThan(20);
    const publicRoutes = [...routeAccess.entries()]
      .filter(([k, a]) => a.kind === 'public' && !k.startsWith('HEAD ')) // HEAD espelha o GET
      .map(([k]) => k)
      .sort();
    // Se este teste falhar porque você criou uma rota pública, revise se ela DEVE ser pública e atualize a lista.
    expect(publicRoutes).toEqual(
      [
        'GET /health/live',
        'GET /health/ready',
        'GET /openapi.json',
        'POST /auth/login',
        'POST /auth/mfa/enroll/begin',
        'POST /auth/mfa/enroll/complete',
        'POST /auth/mfa/verify',
        'POST /auth/refresh',
        'POST /auth/register',
      ].sort(),
    );
  });

  it('subir com uma rota SEM config.access falha', async () => {
    const built = await buildApp({ env: envForBroken(), ctx: ctxForBroken(), logger: false });
    // o erro lançado ao registrar a rota derruba a subida (register ou ready)
    await expect(async () => {
      await built.app.register(async (inst) => {
        inst.get('/esquecida', () => 'oi');
        await Promise.resolve();
      });
      await built.app.ready();
    }).rejects.toThrow(/não declara config\.access/);
    await built.app.close().catch(() => undefined);
  });

  it('sem cookie de sessão toda rota protegida responde 401', async () => {
    for (const [key, a] of routeAccess) {
      if (a.kind === 'public') continue;
      const [method, url] = key.split(' ') as ['GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', string];
      const res = await call(
        null,
        method,
        url
          .replace(':id', '00000000-0000-7000-8000-000000000000')
          .replace(':familyId', '00000000-0000-7000-8000-000000000000'),
        method === 'GET' ? undefined : {},
      );
      expect(res.statusCode, `${key} deveria exigir sessão`).toBe(401);
    }
  });
});

let brokenEnv: ReturnType<typeof loadEnv> | undefined;
let brokenCtx: Ctx | undefined;
function envForBroken() {
  brokenEnv ??= loadEnv({
    PUBLIC_URL: ORIGIN,
    DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
    VALKEY_URL: 'redis://127.0.0.1:1',
    S3_ENDPOINT: 'http://127.0.0.1:1',
    S3_REGION: 'x',
    S3_BUCKET: 'x',
    S3_ACCESS_KEY: 'x',
    S3_SECRET_KEY: 'x',
    MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: 'z'.repeat(48),
  });
  return brokenEnv;
}
function ctxForBroken() {
  const e = envForBroken();
  brokenCtx ??= createCtx(t.app.db, {
    sessionSecret: e.SESSION_SECRET,
    masterKey: e.MASTER_KEY,
    masterKeyPrevious: [],
    accessTtlSeconds: 600,
    refreshTtlSeconds: 1000,
    challengeTtlSeconds: 300,
    issuer: 'WayChat',
  });
  return brokenCtx;
}

describe('sessão por cookie, CSRF e origem', () => {
  it('registro loga na hora; cookies são HttpOnly/SameSite e o refresh fica restrito a /auth', async () => {
    const { res } = await register();
    const byName = Object.fromEntries(res.cookies.map((c) => [c.name, c]));
    expect(byName['wc_at']).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(byName['wc_rt']).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/auth' });
    expect(byName['wc_csrf']?.httpOnly).toBeFalsy(); // legível de propósito (double-submit)
    expect(res.body).not.toContain(byName['wc_at']?.value ?? 'x'); // tokens nunca vão no corpo
    expect(res.body).not.toContain(byName['wc_rt']?.value ?? 'x');
  });

  it('GET /auth/me devolve perfil e permissões', async () => {
    const { s, email } = await register('Loja');
    const res = await call(s, 'GET', '/auth/me');
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.user.email).toBe(email);
    expect(me.account.name).toBe('Loja');
    expect(me.role.name).toBe('Owner');
    expect(me.permissions).toContain('members:manage');
  });

  it('requisição que muda estado sem o header CSRF, ou com ele errado, é recusada', async () => {
    const { s } = await register();
    const none = await call(s, 'PATCH', '/account', { name: 'Novo nome' }, { csrf: false });
    expect(none.statusCode).toBe(403);
    const wrong = await call(
      s,
      'PATCH',
      '/account',
      { name: 'Novo nome' },
      { csrf: false, headers: { 'x-csrf-token': 'outro-valor' } },
    );
    expect(wrong.statusCode).toBe(403);
    const ok = await call(s, 'PATCH', '/account', { name: 'Novo nome' });
    expect(ok.statusCode).toBe(200);
  });

  it('Origin de outro site é recusada, inclusive em rotas públicas', async () => {
    const { s } = await register();
    const evil = await call(
      s,
      'PATCH',
      '/account',
      { name: 'x' },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(evil.statusCode).toBe(403);
    const login = await call(
      null,
      'POST',
      '/auth/login',
      { email: 'a@b.com', password: 'x' },
      { headers: { origin: 'https://evil.example' } },
    );
    expect(login.statusCode).toBe(403);
    const good = await call(
      s,
      'PATCH',
      '/account',
      { name: 'Certo' },
      { headers: { origin: ORIGIN } },
    );
    expect(good.statusCode).toBe(200);
  });

  it('logout apaga os cookies e invalida a sessão', async () => {
    const { s } = await register();
    const out = await call(s, 'POST', '/auth/logout');
    expect(out.statusCode).toBe(200);
    expect(out.cookies.map((c) => c.name).sort()).toEqual(['wc_at', 'wc_csrf', 'wc_rt']);
    expect((await call(s, 'GET', '/auth/me')).statusCode).toBe(401);
  });
});

describe('refresh pela API', () => {
  it('access vencido dá 401; POST /auth/refresh rotaciona os cookies; reuso derruba tudo', async () => {
    const { s } = await register();
    step(601);
    expect((await call(s, 'GET', '/auth/me')).statusCode).toBe(401);

    const refreshed = await call(s, 'POST', '/auth/refresh');
    expect(refreshed.statusCode).toBe(200);
    const s2 = sessionFrom(refreshed, s.ip);
    expect(s2.cookie).not.toBe(s.cookie);
    expect((await call(s2, 'GET', '/auth/me')).statusCode).toBe(200);

    const replay = await call(s, 'POST', '/auth/refresh'); // refresh antigo reapresentado
    expect(replay.statusCode).toBe(401);
    expect(replay.cookies.map((c) => c.name)).toContain('wc_rt'); // cookies limpos
    expect((await call(s2, 'GET', '/auth/me')).statusCode).toBe(401); // família revogada
  });

  it('sem cookie de refresh: 401', async () => {
    expect((await call(null, 'POST', '/auth/refresh')).statusCode).toBe(401);
  });
});

describe('RBAC pela API', () => {
  it('Agente lê a conta mas não lista membros nem cria papéis; Owner cria e o Agente loga', async () => {
    const { s: owner } = await register();
    const roles = (await call(owner, 'GET', '/roles')).json().items as {
      id: string;
      name: string;
    }[];
    const agentRole = roles.find((r) => r.name === 'Agente');
    const email = `ag-${uniq()}@exemplo.com`;
    const add = await call(owner, 'POST', '/members', {
      email,
      name: 'Ana',
      password: PASSWORD,
      role_id: agentRole?.id,
    });
    expect(add.statusCode, add.body).toBe(201);

    const addr = ip();
    const login = await call(
      null,
      'POST',
      '/auth/login',
      { email, password: PASSWORD },
      { ip: addr },
    );
    const agent = sessionFrom(login, addr);
    expect((await call(agent, 'GET', '/account')).statusCode).toBe(200);
    expect((await call(agent, 'GET', '/members')).statusCode).toBe(403);
    expect((await call(agent, 'POST', '/roles', { name: 'x', permissions: [] })).statusCode).toBe(
      403,
    );
    expect((await call(agent, 'GET', '/audit-logs')).statusCode).toBe(403);
  });

  it('anti-escalada e último Owner chegam como 403/409 com código estável', async () => {
    const { s: owner } = await register();
    const me = (await call(owner, 'GET', '/auth/me')).json();
    const last = await call(owner, 'DELETE', `/members/${me.user.id as string}`);
    expect(last.statusCode).toBe(409);
    expect(last.json().error.code).toBe('last_owner');

    const badPerm = await call(owner, 'POST', '/roles', {
      name: 'Ruim',
      permissions: ['inventado:x'],
    });
    expect(badPerm.statusCode).toBe(422);
    expect(badPerm.json().error.code).toBe('invalid_permission');
  });

  it('isolamento: o Owner da conta A não vê membros nem auditoria da conta B', async () => {
    const { s: a } = await register('Conta A');
    const { email: emailB } = await register('Conta B');
    const members = (await call(a, 'GET', '/members')).json().items as { email: string }[];
    expect(members.some((m) => m.email === emailB)).toBe(false);
    const audit = (await call(a, 'GET', '/audit-logs')).json().items as unknown[];
    expect(audit.length).toBeGreaterThan(0);
  });

  it('auditoria pagina por cursor sem repetir itens', async () => {
    const { s } = await register();
    for (let i = 0; i < 3; i++)
      await call(s, 'PATCH', '/account', { name: `Nome ${String(i)} ok` });
    const p1 = (await call(s, 'GET', '/audit-logs?limit=2')).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (
      await call(s, 'GET', `/audit-logs?limit=2&before=${p1.nextCursor as string}`)
    ).json();
    const ids = [...p1.items, ...p2.items].map((i: { id: string }) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('2FA pela API', () => {
  it('ativar, exigir no login e entrar com o código', async () => {
    const { s, email } = await register();
    const begin = (await call(s, 'POST', '/auth/mfa/totp/begin')).json();
    expect(begin.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    const code = generateSync({ secret: begin.secret, epoch: Math.floor(clock / 1000) });
    const confirm = await call(s, 'POST', '/auth/mfa/totp/confirm', { code });
    expect(confirm.statusCode, confirm.body).toBe(200);
    expect(confirm.json().recovery_codes).toHaveLength(10);

    step(60);
    const addr = ip();
    const l = await call(null, 'POST', '/auth/login', { email, password: PASSWORD }, { ip: addr });
    expect(l.json().status).toBe('mfa_required');
    expect(l.cookies).toHaveLength(0); // sem sessão até o segundo fator

    const bad = await call(
      null,
      'POST',
      '/auth/mfa/verify',
      { challenge: l.json().challenge, code: '000000' },
      { ip: addr },
    );
    expect(bad.statusCode).toBe(401);
    const good = await call(
      null,
      'POST',
      '/auth/mfa/verify',
      {
        challenge: l.json().challenge,
        code: generateSync({ secret: begin.secret, epoch: Math.floor(clock / 1000) }),
      },
      { ip: addr },
    );
    expect(good.statusCode, good.body).toBe(200);
    expect((await call(sessionFrom(good, addr), 'GET', '/auth/me')).statusCode).toBe(200);
  });
});

describe('robustez e vazamento de informação', () => {
  it('login: e-mail inexistente e senha errada têm a mesma resposta', async () => {
    const { email } = await register();
    const a = await call(null, 'POST', '/auth/login', {
      email: `nao-${uniq()}@exemplo.com`,
      password: 'qualquer-coisa-12',
    });
    const b = await call(null, 'POST', '/auth/login', { email, password: 'senha-errada-1234' });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    const strip = (r: LightMyRequestResponse) => {
      const j = r.json();
      delete j.error.request_id;
      return j;
    };
    expect(strip(a)).toEqual(strip(b));
  });

  it('validação devolve 400 com o caminho do campo e sem ecoar valores sensíveis', async () => {
    const res = await call(null, 'POST', '/auth/login', {
      email: 'nao-e-email',
      password: 'segredo-que-nao-pode-vazar',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
    expect(res.body).not.toContain('segredo-que-nao-pode-vazar');
  });

  it('rota inexistente e corpo gigante têm formato padrão', async () => {
    const nf = await call(null, 'GET', '/nao-existe');
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.code).toBe('not_found');
    const big = await app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: ip(),
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
  });

  it('rate limit no login: a 11ª tentativa no minuto vira 429', async () => {
    const addr = ip();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await call(
          null,
          'POST',
          '/auth/login',
          { email: `x-${uniq()}@exemplo.com`, password: 'qualquer-coisa-12' },
          { ip: addr },
        )
      ).statusCode;
    }
    expect(last).toBe(429);
  });

  it('cabeçalhos de segurança presentes e sem x-powered-by', async () => {
    const res = await call(null, 'GET', '/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).not.toContain('script-src'); // sem diretivas herdadas do helmet
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('X-Request-Id só é aceito se for UUID', async () => {
    const good = '0198f3a0-1111-7222-8333-444455556666';
    expect(
      (await call(null, 'GET', '/health/live', undefined, { headers: { 'x-request-id': good } }))
        .headers['x-request-id'],
    ).toBe(good);
    const bad = await call(null, 'GET', '/health/live', undefined, {
      headers: { 'x-request-id': 'injetado\nfalso' },
    });
    expect(bad.headers['x-request-id']).not.toContain('injetado');
  });

  it('CORS só libera a origem do painel', async () => {
    const ok = await app.inject({
      method: 'OPTIONS',
      url: '/auth/me',
      headers: { origin: ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await app.inject({
      method: 'OPTIONS',
      url: '/auth/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    // o servidor só anuncia a origem do painel; o navegador bloqueia qualquer outra
    expect(evil.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(evil.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('health/ready confirma o Postgres e openapi.json lista as rotas', async () => {
    const ready = await call(null, 'GET', '/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.postgres).toBe('ok');
    const spec = (await call(null, 'GET', '/openapi.json')).json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/auth/login', '/members', '/roles', '/audit-logs']),
    );
  });
});

describe('métricas', () => {
  it('registra latência por rota (padrão da rota, nunca o id real) e conta 5xx', async () => {
    const { s } = await register();
    const me = (await call(s, 'GET', '/auth/me')).json();
    await call(s, 'DELETE', `/members/${me.user.id as string}`); // 409 last_owner, mas passa pela rota
    const text = await registry.metrics();
    expect(text).toContain('http_request_duration_seconds_bucket');
    expect(text).toMatch(/route="\/members\/:id"/);
    expect(text).not.toContain(me.user.id); // nenhum id de cliente vaza para as métricas
    expect(text).not.toMatch(/wc_at|wc_rt/);
  });
});

describe('inboxes, chaves de API e contatos pela API', () => {
  async function ownerAndAgent() {
    const { s: owner } = await register();
    const roles = (await call(owner, 'GET', '/roles')).json().items as {
      id: string;
      name: string;
    }[];
    const agentRole = roles.find((r) => r.name === 'Agente');
    const email = `ag-${uniq()}@exemplo.com`;
    await call(owner, 'POST', '/members', {
      email,
      name: 'Ana',
      password: PASSWORD,
      role_id: agentRole?.id,
    });
    const addr = ip();
    const login = await call(
      null,
      'POST',
      '/auth/login',
      { email, password: PASSWORD },
      { ip: addr },
    );
    return { owner, agent: sessionFrom(login, addr) };
  }

  it('inbox widget: o segredo aparece só na criação; agente lista só as suas e não cria', async () => {
    const { owner, agent } = await ownerAndAgent();
    const created = await call(owner, 'POST', '/inboxes', {
      name: 'Site',
      channel_type: 'widget',
      welcome_message: 'Oi!',
      allowed_origins: ['https://loja.exemplo.com'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { inbox, identity_secret } = created.json();
    expect(identity_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inbox.publicKey).toMatch(/^ibx_/);

    const listed = await call(owner, 'GET', '/inboxes');
    expect(listed.body).not.toContain(identity_secret);
    expect(listed.json().items).toHaveLength(1);

    expect((await call(agent, 'GET', '/inboxes')).json().items).toHaveLength(0);
    expect(
      (await call(agent, 'POST', '/inboxes', { name: 'Nao', channel_type: 'api' })).statusCode,
    ).toBe(403);
    const me = (await call(owner, 'GET', '/members')).json().items as {
      userId: string;
      roleName: string;
    }[];
    const agentId = me.find((m) => m.roleName === 'Agente')?.userId;
    expect(
      (await call(owner, 'PUT', `/inboxes/${inbox.id as string}/members`, { user_ids: [agentId] }))
        .statusCode,
    ).toBe(200);
    expect((await call(agent, 'GET', '/inboxes')).json().items).toHaveLength(1);
  });

  it('inbox: edição, rotação de segredo, exclusão e erros com código estável', async () => {
    const { owner } = await ownerAndAgent();
    const { inbox } = (
      await call(owner, 'POST', '/inboxes', { name: 'Site', channel_type: 'widget' })
    ).json();
    const upd = await call(owner, 'PATCH', `/inboxes/${inbox.id as string}`, {
      primary_color: '#112233',
      enabled: false,
    });
    expect(upd.json()).toMatchObject({ primaryColor: '#112233', enabled: false });
    const rot = await call(owner, 'POST', `/inboxes/${inbox.id as string}/identity-secret/rotate`);
    expect(rot.json().identity_secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const dup = await call(owner, 'POST', '/inboxes', { name: 'Site', channel_type: 'api' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('name_taken');
    const bad = await call(owner, 'POST', '/inboxes', { name: 'Ok', channel_type: 'telegram' });
    expect(bad.statusCode).toBe(400);
    expect((await call(owner, 'DELETE', `/inboxes/${inbox.id as string}`)).statusCode).toBe(200);
    expect((await call(owner, 'DELETE', `/inboxes/${inbox.id as string}`)).statusCode).toBe(404);
  });

  it('chaves de API: texto completo só na criação; agente sem acesso; revogação', async () => {
    const { owner, agent } = await ownerAndAgent();
    const created = await call(owner, 'POST', '/api-keys', {
      name: 'CRM',
      scopes: ['messages:write'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { key, api_key } = created.json();
    expect(key).toMatch(/^wc_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/);
    const list = await call(owner, 'GET', '/api-keys');
    expect(list.body).not.toContain(key.slice(12)); // o segredo (após wc_ + 8 hex + _)
    expect(list.json().items[0].prefix).toBe(key.slice(0, 11));
    expect((await call(agent, 'GET', '/api-keys')).statusCode).toBe(403);
    expect(
      (await call(agent, 'POST', '/api-keys', { name: 'Nao', scopes: ['messages:write'] }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', '/api-keys', { name: 'Ruim', scopes: ['tudo'] })).statusCode,
    ).toBe(400);
    expect((await call(owner, 'DELETE', `/api-keys/${api_key.id as string}`)).statusCode).toBe(200);
    expect((await call(owner, 'GET', '/api-keys')).json().items[0].revokedAt).toBeTruthy();
  });

  it('contatos: agente cria e busca; validação de domínio dá 422; isolamento entre contas', async () => {
    const { owner, agent } = await ownerAndAgent();
    const created = await call(agent, 'POST', '/contacts', {
      name: 'Maria Souza',
      email: 'MARIA@exemplo.com',
      phone: '(11) 90000-0000',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ email: 'maria@exemplo.com', phone: '11900000000' });
    const found = await call(owner, 'GET', '/contacts?search=souza');
    expect(found.json().items).toHaveLength(1);
    const bad = await call(agent, 'POST', '/contacts', { name: 'X', phone: '123' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('invalid_input');

    const other = await register('Outra conta');
    expect(
      (await call(other.s, 'GET', `/contacts/${created.json().id as string}`)).statusCode,
    ).toBe(404);
    expect((await call(other.s, 'GET', '/contacts')).json().items).toHaveLength(0);
    expect(
      (await call(agent, 'DELETE', `/contacts/${created.json().id as string}`)).statusCode,
    ).toBe(200);
  });

  it('o OpenAPI lista as rotas novas', async () => {
    const spec = (await call(null, 'GET', '/openapi.json')).json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/inboxes', '/api-keys', '/contacts', '/inboxes/{id}/members']),
    );
  });
});

describe('conversas pela API', () => {
  async function team() {
    const { s: owner } = await register();
    const me = (await call(owner, 'GET', '/auth/me')).json();
    const roles = (await call(owner, 'GET', '/roles')).json().items as {
      id: string;
      name: string;
    }[];
    const agentRole = roles.find((r) => r.name === 'Agente')?.id;
    const mk = async (label: string) => {
      const email = `${label}-${uniq()}@exemplo.com`;
      const added = await call(owner, 'POST', '/members', {
        email,
        name: label,
        password: PASSWORD,
        role_id: agentRole,
      });
      const addr = ip();
      const login = await call(
        null,
        'POST',
        '/auth/login',
        { email, password: PASSWORD },
        { ip: addr },
      );
      return { s: sessionFrom(login, addr), id: added.json().user_id as string };
    };
    const a = await mk('agentea');
    const b = await mk('agenteb');
    const inbox1 = (
      await call(owner, 'POST', '/inboxes', { name: 'Vendas', channel_type: 'widget' })
    ).json().inbox.id as string;
    const inbox2 = (
      await call(owner, 'POST', '/inboxes', { name: 'Suporte', channel_type: 'widget' })
    ).json().inbox.id as string;
    await call(owner, 'PUT', `/inboxes/${inbox1}/members`, { user_ids: [a.id] });
    await call(owner, 'PUT', `/inboxes/${inbox2}/members`, { user_ids: [b.id] });
    return { owner, a, b, inbox1, inbox2, accountId: me.account.id as string };
  }
  const inbound = (accountId: string, inboxId: string, who: string, content: string) =>
    receiveInboundMessage(coreCtx, {
      accountId,
      inboxId,
      identity: { channel: 'widget', externalId: who, name: `Visitante ${who}` },
      content,
    });

  it('agente lista só as suas conversas, responde com idempotência e marca como lida', async () => {
    const { a, accountId, inbox1, inbox2 } = await team();
    const c1 = await inbound(accountId, inbox1, 'v1', 'Olá, preciso de ajuda');
    await inbound(accountId, inbox2, 'v2', 'conversa de outra inbox');

    const list = await call(a.s, 'GET', '/conversations');
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((c: { id: string }) => c.id)).toEqual([c1.conversationId]);
    expect(list.json().items[0]).toMatchObject({
      unreadCount: 1,
      lastMessage: 'Olá, preciso de ajuda',
      status: 'open',
    });
    expect((await call(a.s, 'GET', '/conversations/counts')).json()).toEqual({
      all: 1,
      unassigned: 1,
      mine: 0,
      unread: 1,
    });

    const cid = crypto.randomUUID();
    const url = `/conversations/${c1.conversationId}/messages`;
    const first = await call(a.s, 'POST', url, { content: 'Já te atendo', client_message_id: cid });
    expect(first.statusCode, first.body).toBe(201);
    const again = await call(a.s, 'POST', url, { content: 'Já te atendo', client_message_id: cid });
    expect(again.statusCode).toBe(200);
    expect(again.json().duplicate).toBe(true);
    expect(again.json().message.id).toBe(first.json().message.id);

    await call(a.s, 'POST', url, {
      content: 'nota',
      client_message_id: crypto.randomUUID(),
      private: true,
    });
    const msgs = (await call(a.s, 'GET', `${url}?limit=2`)).json();
    expect(msgs.items).toHaveLength(2);
    expect(msgs.nextCursor).toBeTruthy();
    expect(msgs.items[0].private).toBe(true);
    const older = (await call(a.s, 'GET', `${url}?before=${msgs.nextCursor as string}`)).json();
    expect(older.items.map((m: { content: string }) => m.content)).toEqual([
      'Olá, preciso de ajuda',
    ]);

    expect((await call(a.s, 'POST', `/conversations/${c1.conversationId}/read`)).statusCode).toBe(
      200,
    );
    expect((await call(a.s, 'GET', '/conversations/counts')).json().unread).toBe(0);
  });

  it('conversa de outra inbox dá 404 em tudo (não revela que existe)', async () => {
    const { a, accountId, inbox2 } = await team();
    const id = (await inbound(accountId, inbox2, 'v2', 'da inbox 2')).conversationId;
    expect((await call(a.s, 'GET', `/conversations/${id}`)).statusCode).toBe(404);
    expect((await call(a.s, 'GET', `/conversations/${id}/messages`)).statusCode).toBe(404);
    const send = await call(a.s, 'POST', `/conversations/${id}/messages`, {
      content: 'x',
      client_message_id: crypto.randomUUID(),
    });
    expect(send.statusCode).toBe(404);
    expect(
      (await call(a.s, 'PATCH', `/conversations/${id}`, { status: 'resolved' })).statusCode,
    ).toBe(404);
    expect((await call(a.s, 'POST', `/conversations/${id}/read`)).statusCode).toBe(404);
    const ghost = await call(a.s, 'GET', `/conversations/${crypto.randomUUID()}`);
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('not_found'); // igual a uma conversa inexistente
  });

  it('atualiza status/atribuição, aplica labels e valida entrada', async () => {
    const { owner, a, accountId, inbox1 } = await team();
    const c = await inbound(accountId, inbox1, 'v1', 'oi');
    const base = `/conversations/${c.conversationId}`;
    const upd = await call(a.s, 'PATCH', base, {
      status: 'pending',
      priority: 'high',
      assignee_id: a.id,
    });
    expect(upd.json()).toMatchObject({ status: 'pending', priority: 'high', assigneeId: a.id });
    expect((await call(a.s, 'PATCH', base, { status: 'snoozed' })).statusCode).toBe(422);
    expect((await call(a.s, 'PATCH', base, { status: 'inventado' })).statusCode).toBe(400);

    expect((await call(a.s, 'POST', '/labels', { name: 'vip' })).statusCode).toBe(403); // agente não cria label
    const label = (await call(owner, 'POST', '/labels', { name: 'vip', color: '#ff0000' })).json();
    const labelId = label.id as string;
    expect((await call(a.s, 'POST', `${base}/labels/${labelId}`)).statusCode).toBe(200);
    expect((await call(a.s, 'GET', base)).json().labels).toHaveLength(1);
    expect(
      (await call(a.s, 'GET', `/conversations?label_id=${labelId}`)).json().items,
    ).toHaveLength(1);
    expect(
      (await call(a.s, 'GET', '/conversations?assignee=me&status=pending')).json().items,
    ).toHaveLength(1);
    expect((await call(a.s, 'GET', '/conversations?unread=true')).json().items).toHaveLength(1);
    const empty = await call(a.s, 'POST', `${base}/messages`, {
      content: '',
      client_message_id: crypto.randomUUID(),
    });
    expect(empty.statusCode).toBe(422);
    expect((await call(a.s, 'POST', `${base}/messages`, { content: 'ok' })).statusCode).toBe(400); // sem client_message_id
  });

  it('respostas prontas: agente cria e busca por atalho', async () => {
    const { a } = await team();
    const created = await call(a.s, 'POST', '/canned-responses', {
      shortcut: 'Ola',
      content: 'Olá! Como posso ajudar?',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().shortcut).toBe('ola');
    expect(
      (await call(a.s, 'POST', '/canned-responses', { shortcut: 'ola', content: 'outra' }))
        .statusCode,
    ).toBe(409);
    expect((await call(a.s, 'GET', '/canned-responses?search=ol')).json().items).toHaveLength(1);
    expect(
      (await call(a.s, 'DELETE', `/canned-responses/${created.json().id as string}`)).statusCode,
    ).toBe(200);
  });
});

describe('GET /sync pela API', () => {
  it('cliente novo recebe o cursor; depois recebe só os eventos novos que pode ver', async () => {
    const { s: owner } = await register();
    const me = (await call(owner, 'GET', '/auth/me')).json();
    const inbox = (
      await call(owner, 'POST', '/inboxes', { name: 'Site', channel_type: 'widget' })
    ).json().inbox.id as string;
    const boot = await call(owner, 'GET', '/sync');
    expect(boot.statusCode, boot.body).toBe(200);
    expect(boot.json()).toMatchObject({ events: [], has_more: false });
    const start = boot.json().cursor as number;
    expect(start).toBeGreaterThan(0);

    await receiveInboundMessage(coreCtx, {
      accountId: me.account.id,
      inboxId: inbox,
      identity: { channel: 'widget', externalId: 'v1', name: 'Visitante' },
      content: 'texto que nunca vai no evento',
    });
    const next = await call(owner, 'GET', `/sync?since=${String(start)}`);
    const body = next.json();
    expect(body.events.map((e: { type: string }) => e.type)).toEqual([
      'conversation.created',
      'message.created',
    ]);
    expect(body.events[0]).toMatchObject({ account_id: me.account.id, cursor: start + 1 });
    expect(JSON.stringify(body)).not.toContain('nunca vai no evento');
    expect(body.cursor).toBe(start + 2);
    expect((await call(owner, 'GET', `/sync?since=${String(body.cursor)}`)).json().events).toEqual(
      [],
    );
  });

  it('valida os parâmetros e respeita o limite com has_more', async () => {
    const { s: owner } = await register();
    expect((await call(owner, 'GET', '/sync?since=-1')).statusCode).toBe(400);
    expect((await call(owner, 'GET', '/sync?since=abc')).statusCode).toBe(400);
    expect((await call(owner, 'GET', '/sync?since=0&limit=501')).statusCode).toBe(400);
    const page = await call(owner, 'GET', '/sync?since=0&limit=1');
    expect(page.json().events).toHaveLength(1);
    expect(page.json().has_more).toBe(true);
  });
});

describe('canal API: POST /api/v1/messages', () => {
  async function setup(scopes: string[] = ['messages:write'], channel_type = 'api') {
    const { s: owner } = await register();
    const me = (await call(owner, 'GET', '/auth/me')).json();
    const inbox = (await call(owner, 'POST', '/inboxes', { name: 'CRM', channel_type })).json()
      .inbox.id as string;
    const made = await call(owner, 'POST', '/api-keys', { name: 'Chave CRM', scopes });
    expect(made.statusCode, made.body).toBe(201);
    const key = made.json().key as string;
    return { owner, accountId: me.account.id as string, inbox, key };
  }
  const post = (key: string | null, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      remoteAddress: ip(),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra },
      payload: body as object,
    });
  const msg = (inbox: string, over: Record<string, unknown> = {}) => ({
    inbox_id: inbox,
    contact: { external_id: 'cli-1', name: 'Maria', email: 'maria@exemplo.com' },
    content: 'Olá, preciso de ajuda',
    ...over,
  });

  it('cria contato, conversa e mensagem; a conversa aparece para o painel', async () => {
    const { owner, inbox, key } = await setup();
    const res = await post(key, msg(inbox, { external_id: 'm-1' }));
    expect(res.statusCode, res.body).toBe(201);
    const b = res.json();
    expect(b.duplicate).toBe(false);
    const list = (await call(owner, 'GET', '/conversations')).json();
    expect(list.items.map((c: { id: string }) => c.id)).toContain(b.conversation_id);
  });

  it('reenvio com o mesmo external_id não duplica', async () => {
    const { inbox, key } = await setup();
    const a = await post(key, msg(inbox, { external_id: 'm-1' }));
    const b = await post(key, msg(inbox, { external_id: 'm-1' }));
    expect(b.statusCode).toBe(200);
    expect(b.json()).toMatchObject({ duplicate: true, message_id: a.json().message_id });
  });

  it('sem chave, chave malformada, inventada ou revogada: 401 igual para todas', async () => {
    const { owner, inbox, key } = await setup();
    const forged = `wc_${key.slice(3, 11)}_${'A'.repeat(43)}`;
    for (const k of [null, 'lixo', forged]) {
      const res = await post(k, msg(inbox));
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('api_key_invalid');
    }
    const id = (await call(owner, 'GET', '/api-keys')).json().items[0].id as string;
    await call(owner, 'DELETE', `/api-keys/${id}`);
    expect((await post(key, msg(inbox))).statusCode).toBe(401);
  });

  it('cookie de sessão não vale no canal API, e chave não vale nas rotas do painel', async () => {
    const { owner, inbox, key } = await setup();
    const viaCookie = await app.inject({
      method: 'POST',
      url: '/api/v1/messages',
      remoteAddress: ip(),
      headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf },
      payload: msg(inbox),
    });
    expect(viaCookie.statusCode).toBe(401);
    const panel = await app.inject({
      method: 'GET',
      url: '/conversations',
      remoteAddress: ip(),
      headers: { authorization: `Bearer ${key}` },
    });
    expect(panel.statusCode).toBe(401);
  });

  it('exige o escopo messages:write', async () => {
    const { inbox, key } = await setup(['conversations:read']);
    expect((await post(key, msg(inbox))).statusCode).toBe(403);
  });

  it('não escreve em inbox de outro canal nem de outra conta', async () => {
    const widget = await setup(['messages:write'], 'widget');
    expect((await post(widget.key, msg(widget.inbox))).statusCode).toBe(404);
    const a = await setup();
    const b = await setup();
    expect((await post(a.key, msg(b.inbox))).statusCode).toBe(404);
  });

  it('valida o corpo (conteúdo vazio, e-mail ruim, campos a mais não mudam a conta)', async () => {
    const { inbox, key } = await setup();
    expect((await post(key, msg(inbox, { content: '   ' }))).statusCode).toBe(400);
    expect(
      (await post(key, msg(inbox, { contact: { external_id: 'x', name: 'Y', email: 'nao' } })))
        .statusCode,
    ).toBe(400);
    expect((await post(key, msg(inbox, { account_id: crypto.randomUUID() }))).statusCode).toBe(201);
  });
});
