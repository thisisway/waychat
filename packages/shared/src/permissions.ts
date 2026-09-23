/**
 * Catálogo de permissões (`recurso:ação`). Toda rota da API declara uma delas (ou `public`).
 * Novas fases acrescentam permissões aqui; papéis de sistema são recalculados a partir do catálogo.
 */
export const PERMISSIONS = [
  'account:read',
  'account:update',
  'members:read',
  'members:manage',
  'roles:read',
  'roles:manage',
  'api_keys:read',
  'api_keys:manage',
  'audit:read',
  'sessions:manage_own',
  'inboxes:read',
  'inboxes:manage',
  'contacts:read',
  'contacts:manage',
  'conversations:read',
  'conversations:read_all',
  'conversations:reply',
  'conversations:manage',
  'labels:manage',
  'canned_responses:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

export type SystemRoleName = 'Owner' | 'Admin' | 'Supervisor' | 'Agente';

/** Papéis padrão criados com cada conta. São imutáveis (`is_system`); papéis customizados escolhem qualquer subconjunto do catálogo. */
export const SYSTEM_ROLES: Record<SystemRoleName, readonly Permission[]> = {
  Owner: PERMISSIONS,
  // Owner e Admin têm as mesmas permissões hoje; a diferença é regra de negócio (a conta nunca fica sem Owner).
  Admin: PERMISSIONS,
  Supervisor: [
    'account:read',
    'members:read',
    'roles:read',
    'audit:read',
    'sessions:manage_own',
    'inboxes:read',
    'contacts:read',
    'contacts:manage',
    'conversations:read',
    'conversations:read_all',
    'conversations:reply',
    'conversations:manage',
    'labels:manage',
    'canned_responses:manage',
  ],
  Agente: [
    'account:read',
    'sessions:manage_own',
    'contacts:read',
    'contacts:manage',
    'conversations:read',
    'conversations:reply',
    'conversations:manage',
    'canned_responses:manage',
  ],
};

export const OWNER_ROLE: SystemRoleName = 'Owner';
