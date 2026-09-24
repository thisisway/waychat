import { timingSafeEqual } from 'node:crypto';
import { assertCan, authenticate, DomainError, verifyApiKey, type Ctx } from '@waychat/core';
import type { Env } from '@waychat/shared';
import type { FastifyInstance } from 'fastify';
import { COOKIE } from '../cookies.js';
import type { Access } from '../types.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function equalSecrets(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Autorização deny-by-default:
 *  1. `onRoute` derruba a subida se qualquer rota não declarar `config.access` (a lista fica no Map devolvido, para o teste);
 *  2. `onRequest` aplica, nesta ordem: checagem de Origin (rotas que mudam estado), autenticação,
 *     CSRF double-submit (a sessão vem de cookie) e permissão.
 */
export function registerAccessControl(
  app: FastifyInstance,
  env: Env,
  ctx: Ctx,
): Map<string, Access> {
  const routeAccess = new Map<string, Access>();
  const allowedOrigin = new URL(env.PUBLIC_URL).origin;

  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    // Preflight CORS (OPTIONS) é tratado pelo @fastify/cors e nunca carrega credenciais.
    if (methods.every((m) => m === 'OPTIONS')) return;
    const access = route.config?.access;
    if (!access) {
      throw new Error(
        `Rota ${methods.join(',')} ${route.url} não declara config.access (public | self | permission)`,
      );
    }
    for (const m of methods) routeAccess.set(`${m} ${route.url}`, access);
  });

  app.addHook('onRequest', async (req) => {
    const access = req.routeOptions.config.access;
    if (!access) return; // 404 / preflight

    if (access.kind === 'api_key') {
      // Bearer não é enviado automaticamente pelo navegador, então Origin/CSRF não se aplicam aqui.
      const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
      if (!m?.[1]) throw new DomainError('api_key_invalid');
      const principal = await verifyApiKey(ctx, m[1]);
      if (!principal.scopes.has(access.scope))
        throw new DomainError('forbidden', 'escopo insuficiente');
      req.apiKey = principal;
      return;
    }

    const unsafe = UNSAFE.has(req.method);
    const origin = req.headers.origin;
    if (unsafe && origin && origin !== allowedOrigin) {
      throw new DomainError('forbidden', 'origem não permitida');
    }
    if (access.kind === 'public') return;

    const token = req.cookies[COOKIE.access];
    if (!token) throw new DomainError('invalid_token');
    if (unsafe) {
      const cookie = req.cookies[COOKIE.csrf];
      const header = req.headers['x-csrf-token'];
      if (!cookie || typeof header !== 'string' || !equalSecrets(cookie, header)) {
        throw new DomainError('forbidden', 'csrf');
      }
    }
    const actor = await authenticate(ctx, token);
    if (access.kind === 'permission') assertCan(actor, access.permission);
    req.actor = actor;
  });

  return routeAccess;
}
