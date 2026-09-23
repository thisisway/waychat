import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from './crypto/envelope.js';
import { lockSeconds } from './modules/identity/application/login.js';
import { slugify } from './modules/identity/application/register-account.js';
import { assertPasswordPolicy } from './modules/identity/domain/password-policy.js';
import { DomainError } from './errors.js';

const key = () => randomBytes(32).toString('base64');

describe('Keyring (AES-256-GCM)', () => {
  it('cifra e decifra', () => {
    const k = new Keyring(key());
    const enc = k.encrypt('segredo', 'mfa:u1');
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('segredo');
    expect(k.decrypt(enc, 'mfa:u1')).toBe('segredo');
  });

  it('cada cifragem usa IV novo', () => {
    const k = new Keyring(key());
    expect(k.encrypt('x', 'a')).not.toBe(k.encrypt('x', 'a'));
  });

  it('o AAD amarra o segredo ao contexto: copiar para outra linha falha', () => {
    const k = new Keyring(key());
    const enc = k.encrypt('segredo', 'mfa:u1');
    expect(() => k.decrypt(enc, 'mfa:u2')).toThrow();
  });

  it('detecta adulteração', () => {
    const k = new Keyring(key());
    const [v, kid, iv, tag, ct] = k.encrypt('segredo', 'a').split('.');
    const flipped = Buffer.from(ct ?? '', 'base64url');
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() =>
      k.decrypt([v, kid, iv, tag, flipped.toString('base64url')].join('.'), 'a'),
    ).toThrow();
  });

  it('rotação: decifra com chave antiga, cifra com a nova e sinaliza recifragem', () => {
    const oldKey = key();
    const enc = new Keyring(oldKey).encrypt('segredo', 'a');
    const rotated = new Keyring(key(), [oldKey]);
    expect(rotated.decrypt(enc, 'a')).toBe('segredo');
    expect(rotated.needsRotation(enc)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt('x', 'a'))).toBe(false);
  });

  it('sem a chave antiga a rotação incompleta é detectada', () => {
    const enc = new Keyring(key()).encrypt('segredo', 'a');
    expect(() => new Keyring(key()).decrypt(enc, 'a')).toThrow(/desconhecida/);
  });

  it('rejeita chave que não tem 32 bytes', () => {
    expect(() => new Keyring(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('bloqueio progressivo', () => {
  it('só bloqueia a partir da 5ª falha, dobrando até 15 min', () => {
    expect([1, 2, 3, 4].map(lockSeconds)).toEqual([0, 0, 0, 0]);
    expect(lockSeconds(5)).toBe(30);
    expect(lockSeconds(6)).toBe(60);
    expect(lockSeconds(7)).toBe(120);
    expect(lockSeconds(50)).toBe(900);
  });
});

describe('política de senha', () => {
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return e instanceof DomainError ? e.code : 'outro';
    }
    return 'ok';
  };
  it('exige 12+ caracteres', () => {
    expect(code(() => assertPasswordPolicy('curta123', 'a@b.com'))).toBe('weak_password');
    expect(code(() => assertPasswordPolicy('uma-senha-longa-ok', 'a@b.com'))).toBe('ok');
  });
  it('rejeita repetição e o próprio e-mail', () => {
    expect(code(() => assertPasswordPolicy('aaaaaaaaaaaaaaa', 'x@y.com'))).toBe('weak_password');
    expect(code(() => assertPasswordPolicy('maria.silva@ex.com', 'maria.silva@ex.com'))).toBe(
      'weak_password',
    );
    expect(code(() => assertPasswordPolicy('minha-maria-2024!!', 'maria@ex.com'))).toBe(
      'weak_password',
    );
  });
});

describe('slugify', () => {
  it('remove acentos e símbolos', () => {
    expect(slugify('  Açaí & Cia. Ltda!  ')).toBe('acai-cia-ltda');
    expect(slugify('!!!')).toBe('conta');
  });
});
