import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLES, isPermission } from './permissions.js';

describe('catálogo de permissões', () => {
  it('não tem duplicatas e segue o formato recurso:ação', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(p).toMatch(/^[a-z_]+:[a-z_]+$/);
  });

  it('papéis de sistema só usam permissões do catálogo', () => {
    for (const perms of Object.values(SYSTEM_ROLES)) {
      for (const p of perms) expect(isPermission(p)).toBe(true);
    }
  });

  it('Owner tem tudo; Agente não administra nada', () => {
    expect([...SYSTEM_ROLES.Owner].sort()).toEqual([...PERMISSIONS].sort());
    // o agente edita contatos, mas não administra conta, membros, papéis, chaves nem inboxes
    const manage = SYSTEM_ROLES.Agente.filter((p) => p.endsWith(':manage')).sort();
    expect(manage).toEqual(['contacts:manage']);
    expect(SYSTEM_ROLES.Agente).not.toContain('members:manage');
  });
});
