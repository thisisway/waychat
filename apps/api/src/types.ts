import type { ApiKeyPrincipal, ApiScope, AuthenticatedActor } from '@waychat/core';
import type { Permission } from '@waychat/shared';

/**
 * Toda rota declara UMA forma de acesso em `config.access`; o hook `onRoute` recusa rotas sem ela:
 * - `public`: sem autenticação (login, health...). Precisa ser deliberado.
 * - `self`: qualquer usuário autenticado, agindo só sobre si mesmo (perfil, logout, próprias sessões).
 * - `permission`: exige a permissão do catálogo (`@waychat/shared`).
 * - `api_key`: chave de API no `Authorization: Bearer` com o escopo indicado (canal API, sem cookie nem CSRF).
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'self' }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'api_key'; scope: ApiScope };

export const access = {
  public: { access: { kind: 'public' } } as const,
  self: { access: { kind: 'self' } } as const,
  permission: (permission: Permission) => ({ access: { kind: 'permission', permission } }) as const,
  apiKey: (scope: ApiScope) => ({ access: { kind: 'api_key', scope } }) as const,
};

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    actor?: AuthenticatedActor;
    apiKey?: ApiKeyPrincipal;
  }
}
