/**
 * Erro de regra de negócio com código estável. A camada HTTP traduz `code` para status e mensagem;
 * o texto aqui é para desenvolvedores e nunca deve conter segredos ou dados pessoais.
 */
export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DomainError';
  }
}

export type DomainErrorCode =
  | 'invalid_credentials'
  | 'invalid_token'
  | 'invalid_mfa_code'
  | 'mfa_already_enrolled'
  | 'mfa_not_enrolled'
  | 'weak_password'
  | 'email_taken'
  | 'slug_taken'
  | 'forbidden'
  | 'not_found'
  | 'not_a_member'
  | 'privilege_escalation'
  | 'system_role_immutable'
  | 'role_in_use'
  | 'last_owner'
  | 'invalid_permission'
  | 'name_taken';
