import { randomToken } from '@waychat/core';
import type { TokenPair } from '@waychat/core';
import type { Env } from '@waychat/shared';
import type { FastifyReply } from 'fastify';

export const COOKIE = { access: 'wc_at', refresh: 'wc_rt', csrf: 'wc_csrf' } as const;

const secure = (env: Env) => env.PUBLIC_URL.startsWith('https://');

/**
 * Sessão em cookies HttpOnly (JavaScript da página nunca lê os tokens):
 * - access: enviado a toda a API; refresh: só para /auth (menor superfície);
 * - csrf: legível pelo JS de propósito (double-submit): o front o devolve no header X-CSRF-Token.
 */
export function setAuthCookies(reply: FastifyReply, env: Env, tokens: TokenPair): void {
  const base = { httpOnly: true, secure: secure(env), sameSite: 'lax' as const };
  reply
    .setCookie(COOKIE.access, tokens.accessToken, {
      ...base,
      path: '/',
      expires: tokens.accessExpiresAt,
    })
    .setCookie(COOKIE.refresh, tokens.refreshToken, {
      ...base,
      path: '/auth',
      expires: tokens.refreshExpiresAt,
    })
    .setCookie(COOKIE.csrf, randomToken(24), {
      httpOnly: false,
      secure: secure(env),
      sameSite: 'lax',
      path: '/',
      expires: tokens.refreshExpiresAt,
    });
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply
    .clearCookie(COOKIE.access, { path: '/' })
    .clearCookie(COOKIE.refresh, { path: '/auth' })
    .clearCookie(COOKIE.csrf, { path: '/' });
}
