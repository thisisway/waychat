import { describe, expect, it } from 'vitest';
import { classifyError, GraphError } from './index.js';

const g = (status: number, code: number | null, message = 'erro', details?: string) =>
  new GraphError(status, code, message, details);

describe('classifyError', () => {
  it('janela fechada (131047): não tenta de novo, orienta a usar template', () => {
    const r = classifyError(g(400, 131047));
    expect(r).toMatchObject({ retryable: false, code: 'window_closed' });
    expect(r.userMessage).toContain('24 horas');
  });

  it('limite de taxa (130429, 131056, 80007, 4): tenta de novo', () => {
    for (const code of [130429, 131056, 80007, 4]) {
      expect(classifyError(g(429, code))).toMatchObject({ retryable: true, code: 'rate_limited' });
    }
  });

  it('token/permissão (190, 10): não tenta de novo', () => {
    expect(classifyError(g(401, 190))).toMatchObject({ retryable: false, code: 'auth_error' });
    expect(classifyError(g(403, 10))).toMatchObject({ retryable: false, code: 'auth_error' });
  });

  it('falha transitória da Meta (131000, 131016, 1, 2): tenta de novo', () => {
    for (const code of [131000, 131016, 1, 2]) {
      expect(classifyError(g(500, code))).toMatchObject({
        retryable: true,
        code: 'provider_error',
      });
    }
  });

  it('erros de template (132001, 132012, 132015, 132016): não tenta de novo', () => {
    expect(classifyError(g(400, 132001))).toMatchObject({
      retryable: false,
      code: 'template_missing',
    });
    expect(classifyError(g(400, 132012))).toMatchObject({
      retryable: false,
      code: 'template_params',
    });
    expect(classifyError(g(400, 132015))).toMatchObject({
      retryable: false,
      code: 'template_paused',
    });
    expect(classifyError(g(400, 132016))).toMatchObject({
      retryable: false,
      code: 'template_disabled',
    });
  });

  it('erros de mídia e de entrega (131052, 131053, 131026, 131030, 131021): não tenta de novo', () => {
    for (const code of [131052, 131053, 131026, 131030, 131021]) {
      expect(classifyError(g(400, code)).retryable, String(code)).toBe(false);
    }
  });

  it('parâmetro inválido (100, 131009): não tenta de novo', () => {
    expect(classifyError(g(400, 100))).toMatchObject({ retryable: false, code: 'invalid_request' });
    expect(classifyError(g(400, 131009))).toMatchObject({
      retryable: false,
      code: 'invalid_request',
    });
  });

  it('spam (131048) e número não registrado (133010): não tenta de novo', () => {
    expect(classifyError(g(400, 131048))).toMatchObject({ retryable: false, code: 'spam_limit' });
    expect(classifyError(g(400, 133010))).toMatchObject({
      retryable: false,
      code: 'number_not_registered',
    });
  });

  it('código na faixa de permissões (200–299) sem regra específica vira erro de autenticação', () => {
    expect(classifyError(g(403, 250))).toMatchObject({ retryable: false, code: 'auth_error' });
  });

  it('código desconhecido: usa o status HTTP (429 tenta de novo, 5xx/0 tenta de novo, o resto não)', () => {
    expect(classifyError(g(429, 999999))).toMatchObject({ retryable: true, code: 'rate_limited' });
    expect(classifyError(g(503, 999999))).toMatchObject({ retryable: true, code: 'network_error' });
    expect(classifyError(g(0, 999999))).toMatchObject({ retryable: true, code: 'network_error' });
    expect(classifyError(g(400, 999999))).toMatchObject({
      retryable: false,
      code: 'provider_error',
    });
  });

  it('GraphError sem código: status decide', () => {
    expect(classifyError(g(502, null))).toMatchObject({ retryable: true, code: 'network_error' });
    expect(classifyError(g(0, null))).toMatchObject({ retryable: true, code: 'network_error' });
    expect(classifyError(g(422, null))).toMatchObject({ retryable: false, code: 'provider_error' });
  });

  it('erro que não é GraphError (ex.: exceção qualquer): trata como falha de rede, tenta de novo', () => {
    expect(classifyError(new Error('algo'))).toMatchObject({
      retryable: true,
      code: 'network_error',
    });
    expect(classifyError('string qualquer')).toMatchObject({
      retryable: true,
      code: 'network_error',
    });
    expect(classifyError(null)).toMatchObject({ retryable: true, code: 'network_error' });
  });

  it('objeto plano com "code" numérico (ex.: vindo do webhook de status) também é reconhecido', () => {
    expect(classifyError({ code: 131047 })).toMatchObject({
      retryable: false,
      code: 'window_closed',
    });
    expect(classifyError({ code: 130429 })).toMatchObject({
      retryable: true,
      code: 'rate_limited',
    });
  });

  it('toda mensagem ao usuário está em português e não fica vazia', () => {
    const samples = [g(400, 131047), g(429, 130429), g(500, 1), new Error('x'), { code: 999999 }];
    for (const s of samples) {
      const r = classifyError(s);
      expect(r.userMessage.length).toBeGreaterThan(5);
    }
  });
});
