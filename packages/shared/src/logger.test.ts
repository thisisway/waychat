import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { log: pino(loggerOptions('info', 'test'), stream), lines };
}

describe('redaction do logger', () => {
  it('nunca escreve segredos, tokens, cookies, e-mail nem conteúdo de mensagens', () => {
    const { log, lines } = capture();
    log.info(
      {
        password: 'p4ss-em-claro',
        user: { email: 'pessoa@exemplo.com', refreshToken: 'rt-secreto' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'wc_at=xyz' } },
        message: { content: 'oi, meu CPF é 123' },
        deep: { a: { b: { secret: 'segredo-fundo' } } },
      },
      'evento',
    );
    const out = lines.join('');
    for (const leak of [
      'p4ss-em-claro',
      'pessoa@exemplo.com',
      'rt-secreto',
      'Bearer abc',
      'wc_at=xyz',
      'meu CPF',
      'segredo-fundo',
    ]) {
      expect(out, `vazou: ${leak}`).not.toContain(leak);
    }
    expect(out).toContain('evento');
    expect(out).toContain('[redacted]');
  });
});
