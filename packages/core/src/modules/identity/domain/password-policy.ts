import { DomainError } from '../../../errors.js';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/**
 * Política de senha (NIST 800-63B): comprimento em vez de regras de composição.
 * A verificação contra senhas vazadas (HIBP) está no backlog (Fase 7).
 */
export function assertPasswordPolicy(password: string, email: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new DomainError(
      'weak_password',
      `a senha deve ter entre ${String(PASSWORD_MIN)} e ${String(PASSWORD_MAX)} caracteres`,
    );
  }
  if (new Set(password).size < 5)
    throw new DomainError('weak_password', 'senha com pouca variação');
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  if (
    password.toLowerCase() === email.toLowerCase() ||
    (local.length >= 4 && password.toLowerCase().includes(local))
  ) {
    throw new DomainError('weak_password', 'a senha não pode conter o e-mail');
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
