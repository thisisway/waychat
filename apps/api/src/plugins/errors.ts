import { DomainError, type DomainErrorCode } from '@waychat/core';
import type { FastifyInstance } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

const HTTP: Record<DomainErrorCode, { status: number; message: string }> = {
  invalid_credentials: { status: 401, message: 'E-mail ou senha inválidos.' },
  invalid_token: { status: 401, message: 'Sessão inválida ou expirada.' },
  invalid_mfa_code: { status: 401, message: 'Código de verificação inválido.' },
  forbidden: { status: 403, message: 'Você não tem permissão para isto.' },
  privilege_escalation: {
    status: 403,
    message: 'Você não pode conceder permissões que não possui.',
  },
  not_a_member: { status: 403, message: 'Você não pertence a esta conta.' },
  not_found: { status: 404, message: 'Não encontrado.' },
  email_taken: { status: 409, message: 'Este e-mail já está em uso.' },
  slug_taken: { status: 409, message: 'Este identificador já está em uso.' },
  name_taken: { status: 409, message: 'Já existe um item com este nome.' },
  role_in_use: { status: 409, message: 'O papel está atribuído a membros.' },
  last_owner: { status: 409, message: 'A conta precisa de pelo menos um Owner.' },
  system_role_immutable: { status: 409, message: 'Papéis de sistema não podem ser alterados.' },
  mfa_already_enrolled: { status: 409, message: 'A verificação em duas etapas já está ativa.' },
  mfa_not_enrolled: {
    status: 409,
    message: 'Inicie o cadastro da verificação em duas etapas primeiro.',
  },
  weak_password: {
    status: 422,
    message: 'Senha fraca: use de 12 a 128 caracteres, sem repetição nem o seu e-mail.',
  },
  invalid_permission: { status: 422, message: 'Permissão desconhecida.' },
  invalid_input: { status: 422, message: 'Dados inválidos.' },
  inbox_in_use: {
    status: 409,
    message: 'A caixa de entrada tem conversas: desative-a em vez de excluir.',
  },
  contact_in_use: { status: 409, message: 'O contato tem conversas e não pode ser excluído.' },
  api_key_invalid: { status: 401, message: 'Chave de API inválida.' },
  inbox_disabled: { status: 403, message: 'Esta caixa de entrada está desativada.' },
  rate_limited: { status: 429, message: 'Muitas solicitações. Tente novamente mais tarde.' },
};

/** Traduz erros para `{ error: { code, message, request_id } }`. Erros inesperados nunca vazam detalhes ao cliente. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    const request_id = req.id;
    if (err instanceof DomainError) {
      const { status, message } = HTTP[err.code];
      return reply.status(status).send({ error: { code: err.code, message, request_id } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({
        path: v.instancePath,
        message: v.message ?? 'inválido',
      }));
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Requisição inválida.', request_id, issues },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code =
        status === 429 ? 'rate_limited' : status === 413 ? 'payload_too_large' : 'bad_request';
      const message =
        status === 429
          ? 'Muitas requisições. Tente novamente em instantes.'
          : 'Requisição inválida.';
      return reply.status(status).send({ error: { code, message, request_id } });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply
      .status(500)
      .send({ error: { code: 'internal_error', message: 'Erro interno.', request_id } });
  });

  app.setNotFoundHandler((req, reply) =>
    reply
      .status(404)
      .send({ error: { code: 'not_found', message: 'Rota não encontrada.', request_id: req.id } }),
  );
}
