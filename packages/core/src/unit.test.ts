import { randomBytes } from 'node:crypto';
import type { InboundContent } from '@waychat/channels';
import { describe, expect, it } from 'vitest';
import { Keyring } from './crypto/envelope.js';
import { lockSeconds } from './modules/identity/application/login.js';
import { slugify } from './modules/identity/application/register-account.js';
import { assertPasswordPolicy } from './modules/identity/domain/password-policy.js';
import { mapWhatsAppContent } from './modules/channels/application/inbound.js';
import { serviceWindowFor } from './modules/channels/application/window.js';
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

  it('recusa tag de autenticação truncada (forja por tag curta)', () => {
    const k = new Keyring(key());
    const [v, kid, iv, tag, ct] = k.encrypt('segredo', 'a').split('.');
    const short = Buffer.from(tag ?? '', 'base64url')
      .subarray(0, 4)
      .toString('base64url');
    expect(() => k.decrypt([v, kid, iv, short, ct].join('.'), 'a')).toThrow(/tag/);
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

describe('mapWhatsAppContent (formato da Meta -> registro do WayChat)', () => {
  const media = { id: '1001', mimeType: 'image/jpeg', sha256: 'abc' };

  it('texto vai direto para content, sem atributos', () => {
    expect(mapWhatsAppContent({ type: 'text', body: 'Olá' })).toEqual({
      type: 'text',
      content: 'Olá',
      contentAttributes: {},
      media: null,
    });
  });

  it('imagem/vídeo/documento levam a legenda em content e a mídia para baixar', () => {
    const c: InboundContent = { type: 'image', media, caption: 'Foto' };
    expect(mapWhatsAppContent(c)).toEqual({
      type: 'image',
      content: 'Foto',
      contentAttributes: {},
      media,
    });
    expect(mapWhatsAppContent({ type: 'document', media }).content).toBe(''); // sem legenda
  });

  it('figurinha guarda se é animada', () => {
    expect(
      mapWhatsAppContent({ type: 'sticker', media, animated: true }).contentAttributes,
    ).toEqual({
      animated: true,
    });
  });

  it('áudio vira "voice" quando é mensagem de voz, "audio" caso contrário', () => {
    expect(mapWhatsAppContent({ type: 'audio', media, voice: true }).type).toBe('voice');
    expect(mapWhatsAppContent({ type: 'audio', media, voice: false }).type).toBe('audio');
  });

  it('localização e contatos vão inteiros em contentAttributes, sem texto', () => {
    expect(
      mapWhatsAppContent({ type: 'location', latitude: -23.5, longitude: -46.6, name: 'Sé' }),
    ).toEqual({
      type: 'location',
      content: '',
      contentAttributes: { latitude: -23.5, longitude: -46.6, name: 'Sé' },
      media: null,
    });
    const contacts = [{ name: 'João', phones: [], emails: [] }];
    expect(mapWhatsAppContent({ type: 'contacts', contacts }).contentAttributes).toEqual({
      contacts,
    });
  });

  it('reação leva o emoji em content e o alvo em contentAttributes; remoção tem emoji null', () => {
    expect(
      mapWhatsAppContent({ type: 'reaction', targetProviderId: 'wamid.1', emoji: '👍' }),
    ).toEqual({
      type: 'reaction',
      content: '👍',
      contentAttributes: { target_provider_id: 'wamid.1', emoji: '👍' },
      media: null,
    });
    expect(
      mapWhatsAppContent({ type: 'reaction', targetProviderId: 'wamid.1', emoji: null }).content,
    ).toBe('');
  });

  it('respostas de botão/lista e botão de template levam o título/texto em content', () => {
    expect(mapWhatsAppContent({ type: 'button_reply', replyId: 'a', title: 'Sim' })).toEqual({
      type: 'button_reply',
      content: 'Sim',
      contentAttributes: { reply_id: 'a' },
      media: null,
    });
    expect(
      mapWhatsAppContent({ type: 'list_reply', replyId: 'b', title: 'Plano', description: 'R$ 10' })
        .contentAttributes,
    ).toEqual({ reply_id: 'b', description: 'R$ 10' });
    expect(mapWhatsAppContent({ type: 'button', text: 'Confirmar', payload: 'OK' })).toEqual({
      type: 'button',
      content: 'Confirmar',
      contentAttributes: { payload: 'OK' },
      media: null,
    });
  });

  it('tipo não suportado guarda o tipo original e o detalhe, sem texto', () => {
    expect(
      mapWhatsAppContent({ type: 'unsupported', providerType: 'order', detail: 'não tratado' }),
    ).toEqual({
      type: 'unsupported',
      content: '',
      contentAttributes: { provider_type: 'order', detail: 'não tratado' },
      media: null,
    });
  });
});

describe('serviceWindowFor (janela de 24h do WhatsApp, D7)', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');

  it('canais sem janela: null, mesmo com mensagem recente do cliente', () => {
    expect(serviceWindowFor('widget', now, now)).toBeNull();
    expect(serviceWindowFor('api', now, now)).toBeNull();
  });

  it('WhatsApp: aberta dentro de 24h, fechada depois', () => {
    const dez23hAtras = new Date(now.getTime() - 23 * 3_600_000);
    const dez25hAtras = new Date(now.getTime() - 25 * 3_600_000);
    expect(serviceWindowFor('whatsapp', dez23hAtras, now)).toEqual({
      open: true,
      expiresAt: new Date(dez23hAtras.getTime() + 24 * 3_600_000),
    });
    expect(serviceWindowFor('whatsapp', dez25hAtras, now)?.open).toBe(false);
  });

  it('exatamente no limite das 24h: já fechada (o limite não conta como aberto)', () => {
    const exato24h = new Date(now.getTime() - 24 * 3_600_000);
    expect(serviceWindowFor('whatsapp', exato24h, now)?.open).toBe(false);
  });

  it('contato nunca escreveu: fechada, sem data de expiração', () => {
    expect(serviceWindowFor('whatsapp', null, now)).toEqual({ open: false, expiresAt: null });
  });
});
