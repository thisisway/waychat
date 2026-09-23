import {
  authenticate,
  beginTotpEnrollment,
  completeEnrollmentLogin,
  completeMfaLogin,
  confirmTotpEnrollment,
  DomainError,
  getMe,
  listSessions,
  login,
  logout,
  refreshSession,
  registerAccount,
  revokeOwnSessions,
  verifyChallenge,
  type Ctx,
} from '@waychat/core';
import type { Env } from '@waychat/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { clearAuthCookies, COOKIE, setAuthCookies } from '../cookies.js';
import { access } from '../types.js';

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(1).max(128);
const challenge = z.string().min(20).max(2048);
const otpCode = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'código de 6 dígitos');

const statusBody = z.object({
  status: z.enum(['authenticated', 'mfa_required', 'mfa_enrollment_required']),
  account_id: z.uuid().optional(),
  challenge: z.string().optional(),
});

const loginLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export function authRoutes(app: FastifyInstance, env: Env, ctx: Ctx): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const meta = (req: { ip: string; headers: Record<string, unknown> }) => ({
    ip: req.ip,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });

  r.post(
    '/auth/register',
    {
      config: { ...access.public, rateLimit: { max: 5, timeWindow: '1 hour' } },
      schema: {
        tags: ['auth'],
        body: z.object({
          account_name: z.string().trim().min(2).max(80),
          name: z.string().trim().min(1).max(120),
          email,
          password,
        }),
        response: { 201: statusBody },
      },
    },
    async (req, reply) => {
      const b = req.body;
      await registerAccount(ctx, {
        accountName: b.account_name,
        ownerName: b.name,
        email: b.email,
        password: b.password,
        ...meta(req),
      });
      const result = await login(ctx, { email: b.email, password: b.password, ...meta(req) });
      if (result.status !== 'authenticated') throw new DomainError('invalid_credentials');
      setAuthCookies(reply, env, result.tokens);
      return reply.status(201).send({ status: result.status, account_id: result.accountId });
    },
  );

  r.post(
    '/auth/login',
    {
      config: { ...access.public, ...loginLimit },
      schema: {
        tags: ['auth'],
        body: z.object({ email, password, account_id: z.uuid().optional() }),
        response: { 200: statusBody },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const result = await login(ctx, {
        email: b.email,
        password: b.password,
        ...(b.account_id ? { accountId: b.account_id } : {}),
        ...meta(req),
      });
      if (result.status === 'authenticated') {
        setAuthCookies(reply, env, result.tokens);
        return { status: result.status, account_id: result.accountId };
      }
      return { status: result.status, challenge: result.challenge };
    },
  );

  r.post(
    '/auth/mfa/verify',
    {
      config: { ...access.public, ...loginLimit },
      schema: {
        tags: ['auth'],
        body: z
          .object({
            challenge,
            code: otpCode.optional(),
            recovery_code: z.string().trim().min(8).max(32).optional(),
          })
          .refine(
            (v) => Boolean(v.code) !== Boolean(v.recovery_code),
            'informe code OU recovery_code',
          ),
        response: { 200: statusBody },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const factor = b.code ? { code: b.code } : { recoveryCode: b.recovery_code ?? '' };
      const done = await completeMfaLogin(ctx, { challenge: b.challenge, factor, ...meta(req) });
      setAuthCookies(reply, env, done.tokens);
      return { status: 'authenticated' as const, account_id: done.accountId };
    },
  );

  // Conta que exige 2FA: o usuário ainda sem fator cadastra o TOTP usando o challenge do login.
  r.post(
    '/auth/mfa/enroll/begin',
    {
      config: { ...access.public, ...loginLimit },
      schema: {
        tags: ['auth'],
        body: z.object({ challenge }),
        response: { 200: z.object({ secret: z.string(), otpauth_uri: z.string() }) },
      },
    },
    async (req) => {
      const claims = await verifyChallenge(ctx, req.body.challenge, 'enroll');
      const { secret, otpauthUri } = await beginTotpEnrollment(ctx, claims.sub);
      return { secret, otpauth_uri: otpauthUri };
    },
  );

  r.post(
    '/auth/mfa/enroll/complete',
    {
      config: { ...access.public, ...loginLimit },
      schema: {
        tags: ['auth'],
        body: z.object({ challenge, code: otpCode }),
        response: { 200: statusBody.extend({ recovery_codes: z.array(z.string()) }) },
      },
    },
    async (req, reply) => {
      const done = await completeEnrollmentLogin(ctx, { ...req.body, ...meta(req) });
      setAuthCookies(reply, env, done.tokens);
      return {
        status: 'authenticated' as const,
        account_id: done.accountId,
        recovery_codes: done.recoveryCodes,
      };
    },
  );

  // Usuário já autenticado ativando 2FA por conta própria.
  r.post(
    '/auth/mfa/totp/begin',
    {
      config: access.self,
      schema: {
        tags: ['auth'],
        response: { 200: z.object({ secret: z.string(), otpauth_uri: z.string() }) },
      },
    },
    async (req) => {
      const { secret, otpauthUri } = await beginTotpEnrollment(ctx, actorOf(req).userId);
      return { secret, otpauth_uri: otpauthUri };
    },
  );

  r.post(
    '/auth/mfa/totp/confirm',
    {
      config: access.self,
      schema: {
        tags: ['auth'],
        body: z.object({ code: otpCode }),
        response: { 200: z.object({ recovery_codes: z.array(z.string()) }) },
      },
    },
    async (req) => {
      const { recoveryCodes } = await confirmTotpEnrollment(
        ctx,
        actorOf(req).userId,
        req.body.code,
      );
      return { recovery_codes: recoveryCodes };
    },
  );

  // Público porque a sessão pode estar com o access token vencido; a credencial é o cookie de refresh (path /auth).
  r.post(
    '/auth/refresh',
    {
      config: { ...access.public, rateLimit: { max: 60, timeWindow: '1 minute' } },
      schema: { tags: ['auth'], response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req, reply) => {
      const token = req.cookies[COOKIE.refresh];
      if (!token) throw new DomainError('invalid_token');
      try {
        const tokens = await refreshSession(ctx, token, meta(req));
        setAuthCookies(reply, env, tokens);
      } catch (e) {
        clearAuthCookies(reply);
        throw e;
      }
      return { ok: true as const };
    },
  );

  r.post(
    '/auth/logout',
    {
      config: access.self,
      schema: { tags: ['auth'], response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req, reply) => {
      await logout(ctx, actorOf(req));
      clearAuthCookies(reply);
      return { ok: true as const };
    },
  );

  r.get(
    '/auth/me',
    {
      config: access.self,
      schema: {
        tags: ['auth'],
        response: {
          200: z.object({
            user: z.object({
              id: z.uuid(),
              name: z.string(),
              email: z.string(),
              locale: z.string(),
            }),
            account: z.object({
              id: z.uuid(),
              name: z.string(),
              slug: z.string(),
              require2fa: z.boolean(),
            }),
            role: z.object({ id: z.uuid(), name: z.string() }),
            permissions: z.array(z.string()),
          }),
        },
      },
    },
    (req) => getMe(ctx, actorOf(req)),
  );

  r.get(
    '/auth/sessions',
    {
      config: access.self,
      schema: {
        tags: ['auth'],
        response: {
          200: z.object({
            items: z.array(
              z.object({
                family_id: z.uuid(),
                created_at: z.date(),
                last_used_at: z.date().nullable(),
                ip: z.string().nullable(),
                user_agent: z.string().nullable(),
                current: z.boolean(),
              }),
            ),
          }),
        },
      },
    },
    async (req) => {
      const items = await listSessions(ctx, actorOf(req));
      return {
        items: items.map((s) => ({
          family_id: s.familyId,
          created_at: s.createdAt,
          last_used_at: s.lastUsedAt,
          ip: s.ip,
          user_agent: s.userAgent,
          current: s.current,
        })),
      };
    },
  );

  r.delete(
    '/auth/sessions/:familyId',
    {
      config: access.self,
      schema: {
        tags: ['auth'],
        params: z.object({ familyId: z.uuid() }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (req) => {
      await revokeOwnSessions(ctx, actorOf(req), req.params.familyId);
      return { ok: true as const };
    },
  );

  r.delete(
    '/auth/sessions',
    {
      config: access.self,
      schema: { tags: ['auth'], response: { 200: z.object({ ok: z.literal(true) }) } },
    },
    async (req, reply) => {
      await revokeOwnSessions(ctx, actorOf(req));
      clearAuthCookies(reply);
      return { ok: true as const };
    },
  );
}

/** Rotas `self`/`permission` só executam depois do hook de autenticação; se `actor` faltar, é bug de configuração. */
export function actorOf(req: { actor?: Awaited<ReturnType<typeof authenticate>> }) {
  if (!req.actor) throw new DomainError('invalid_token');
  return req.actor;
}
