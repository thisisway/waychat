import type { ApiKeyPrincipal, ApiScope, AuthenticatedActor, Visitor } from '@waychat/core';
import type { Permission } from '@waychat/shared';

/**
 * Toda rota declara UMA forma de acesso em `config.access`; o hook `onRoute` recusa rotas sem ela:
 * - `public`: sem autenticação (login, health...). Precisa ser deliberado.
 * - `self`: qualquer usuário autenticado, agindo só sobre si mesmo (perfil, logout, próprias sessões).
 * - `permission`: exige a permissão do catálogo (`@waychat/shared`).
 * - `api_key`: chave de API no `Authorization: Bearer` com o escopo indicado (canal API, sem cookie nem CSRF).
 * - `visitor`: visitante do widget, com o token de sessão do widget no `Authorization: Bearer`.
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'self' }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'api_key'; scope: ApiScope }
  | { kind: 'visitor' };

export const access = {
  public: { access: { kind: 'public' } } as const,
  self: { access: { kind: 'self' } } as const,
  permission: (permission: Permission) => ({ access: { kind: 'permission', permission } }) as const,
  visitor: { access: { kind: 'visitor' } } as const,
  apiKey: (scope: ApiScope) => ({ access: { kind: 'api_key', scope } }) as const,
};

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
    /** Rota pública chamada de outros sites (o widget): pula a checagem de Origin do painel. */
    anyOrigin?: boolean;
  }
  interface FastifyRequest {
    actor?: AuthenticatedActor;
    apiKey?: ApiKeyPrincipal;
    visitor?: Visitor;
    /** Corpo bruto de webhooks (a assinatura é calculada sobre os bytes originais). */
    rawBody?: Buffer;
  }
}
