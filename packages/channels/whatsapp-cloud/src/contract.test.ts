import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NormalizedEvent } from '@waychat/channels';
import { describe, expect, it } from 'vitest';
import { parseWebhook, verifyChallenge, verifySignature } from './index.js';

const dir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(`${dir}${name}.json`, 'utf8')) as unknown;
const parse = (name: string) => parseWebhook(fixture(name));
const only = (name: string): NormalizedEvent => {
  const events = parse(name);
  expect(events, name).toHaveLength(1);
  return events[0] as NormalizedEvent;
};
const message = (name: string) => {
  const e = only(name);
  if (e.kind !== 'message') throw new Error(`${name}: esperava mensagem`);
  return e;
};

describe('contrato: mensagens de entrada (payloads do webhook da Meta)', () => {
  it('texto, com nome do perfil, horário e id de deduplicação', () => {
    expect(message('text')).toEqual({
      kind: 'message',
      providerId: 'wamid.TEXT001',
      accountRef: '106540352242922',
      from: { id: '5511988887777', name: 'Maria Souza' },
      at: new Date(1758700000 * 1000),
      content: { type: 'text', body: 'Olá, *preciso* de ajuda com o pedido 123' },
    });
  });

  it('resposta citada guarda o id da mensagem original', () => {
    expect(message('text-reply').replyToProviderId).toBe('wamid.ORIGINAL001');
  });

  it('imagem, vídeo, documento e sticker trazem o id da mídia para baixar', () => {
    expect(message('image').content).toEqual({
      type: 'image',
      media: { id: '1001001001', mimeType: 'image/jpeg', sha256: 'Zm9vYmFy' },
      caption: 'Foto do produto',
    });
    expect(message('video').content).toMatchObject({ type: 'video', caption: 'Veja o defeito' });
    expect(message('document').content).toMatchObject({
      type: 'document',
      media: { id: '4004004004', fileName: 'contrato.pdf', mimeType: 'application/pdf' },
      caption: 'Segue o contrato',
    });
    expect(message('sticker').content).toMatchObject({ type: 'sticker', animated: false });
  });

  it('áudio comum e mensagem de voz se distinguem', () => {
    expect(message('audio').content).toMatchObject({ type: 'audio', voice: false });
    expect(message('voice').content).toMatchObject({
      type: 'audio',
      voice: true,
      media: { mimeType: 'audio/ogg; codecs=opus' },
    });
  });

  it('localização', () => {
    expect(message('location').content).toEqual({
      type: 'location',
      latitude: -23.55052,
      longitude: -46.633308,
      name: 'Praça da Sé',
      address: 'Praça da Sé, São Paulo',
    });
  });

  it('contatos compartilhados', () => {
    expect(message('contacts').content).toEqual({
      type: 'contacts',
      contacts: [
        {
          name: 'João Silva',
          phones: [
            { phone: '+55 11 97777-6666', waId: '5511977776666', kind: 'CELL' },
            { phone: '+55 11 3333-2222', kind: 'WORK' },
          ],
          emails: ['joao@exemplo.com'],
        },
      ],
    });
  });

  it('reação e remoção de reação (sem emoji)', () => {
    expect(message('reaction').content).toEqual({
      type: 'reaction',
      targetProviderId: 'wamid.ORIGINAL001',
      emoji: '👍',
    });
    expect(message('reaction-removed').content).toEqual({
      type: 'reaction',
      targetProviderId: 'wamid.ORIGINAL001',
      emoji: null,
    });
  });

  it('respostas de botão e de lista (interativas) e botão de template', () => {
    const btn = message('interactive-button-reply');
    expect(btn.content).toEqual({ type: 'button_reply', replyId: 'btn_sim', title: 'Sim' });
    expect(btn.replyToProviderId).toBe('wamid.ORIGINAL002');
    expect(message('interactive-list-reply').content).toEqual({
      type: 'list_reply',
      replyId: 'plano_a',
      title: 'Plano A',
      description: 'R$ 49,90 por mês',
    });
    expect(message('button-template-reply').content).toEqual({
      type: 'button',
      text: 'Confirmar',
      payload: 'CONFIRMAR_PEDIDO',
    });
  });

  it('tipo não suportado pela Meta e tipo novo desconhecido viram "unsupported", sem derrubar nada', () => {
    expect(message('unsupported').content).toEqual({
      type: 'unsupported',
      providerType: 'unsupported',
      detail: 'Message type is not currently supported',
    });
    expect(message('unknown-type').content).toMatchObject({
      type: 'unsupported',
      providerType: 'order',
    });
  });
});

describe('contrato: status, templates e qualidade', () => {
  it('status sent/delivered/read guardam o id que enviamos em biz_opaque_callback_data', () => {
    for (const s of ['sent', 'delivered', 'read'] as const) {
      const e = only(`status-${s}`);
      expect(e).toMatchObject({
        kind: 'status',
        status: s,
        providerId: 'wamid.OUT001',
        recipientId: '5511988887777',
        opaque: 'msg-0192f0c0-0000-7000-8000-000000000001',
      });
    }
  });

  it('status failed traz o erro da Meta com o detalhe', () => {
    const e = only('status-failed');
    expect(e).toMatchObject({
      kind: 'status',
      status: 'failed',
      error: { code: 131047, title: 'Re-engagement message' },
    });
    if (e.kind === 'status') expect(e.error?.details).toContain('24 hours');
  });

  it('atualização de status de template (aprovado e rejeitado com motivo)', () => {
    expect(only('template-approved')).toEqual({
      kind: 'template_status',
      wabaId: '102290129340398',
      providerTemplateId: '1234567890',
      name: 'confirmacao_pedido',
      language: 'pt_BR',
      status: 'approved',
    });
    expect(only('template-rejected')).toMatchObject({
      status: 'rejected',
      reason: 'INCORRECT_CATEGORY',
    });
  });

  it('atualização de qualidade do número', () => {
    expect(only('quality-update')).toEqual({
      kind: 'quality',
      wabaId: '102290129340398',
      displayPhone: '5511999990000',
      event: 'FLAGGED',
      tier: 'TIER_1K',
    });
  });

  it('um POST com várias mensagens e status devolve tudo, na ordem', () => {
    const events = parse('batch');
    expect(
      events.map((e) =>
        e.kind === 'message' ? e.providerId : `${e.kind}:${'providerId' in e ? e.providerId : ''}`,
      ),
    ).toEqual(['wamid.B1', 'wamid.B2', 'status:wamid.OUT002']);
  });
});

describe('contrato: robustez', () => {
  it('todas as fixtures do diretório têm teste (nenhuma ficou de fora)', () => {
    const names = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(names).toHaveLength(25);
    for (const f of names)
      expect(() => parseWebhook(fixture(f.replace('.json', '')))).not.toThrow();
  });

  it('item malformado é descartado sem impedir os demais', () => {
    const body = fixture('batch') as { entry: { changes: { value: { messages: unknown[] } }[] }[] };
    const first = body.entry[0]?.changes[0]?.value;
    first?.messages.unshift({ lixo: true }, { from: 1, id: null });
    expect(parseWebhook(body).map((e) => e.kind)).toEqual(['message', 'message', 'status']);
  });

  it('corpo que não é um envelope da Meta lança (o handler responde 400)', () => {
    expect(() => parseWebhook(null)).toThrow();
    expect(() => parseWebhook({ entry: 'x' })).toThrow();
  });

  it('status desconhecido (ex.: deleted) e campos desconhecidos são ignorados', () => {
    const body = fixture('status-read') as {
      entry: { changes: { field: string; value: { statuses: { status: string }[] } }[] }[];
    };
    const change = body.entry[0]?.changes[0];
    if (change) change.value.statuses[0] = { ...change.value.statuses[0], status: 'deleted' };
    body.entry[0]?.changes.push({ field: 'algo_novo', value: { statuses: [] } });
    expect(parseWebhook(body)).toEqual([]);
  });
});

describe('assinatura e verificação do webhook', () => {
  const secret = 'app-secret-de-teste';
  const raw = Buffer.from(JSON.stringify(fixture('text')));
  const sig = (body: Buffer, key = secret) =>
    `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;

  it('aceita a assinatura correta do corpo bruto', () => {
    expect(verifySignature(raw, sig(raw), secret)).toBe(true);
    expect(verifySignature(raw, sig(raw).toUpperCase().replace('SHA256=', 'sha256='), secret)).toBe(
      true,
    );
  });

  it('recusa corpo alterado, segredo errado, cabeçalho ausente ou malformado (sem lançar)', () => {
    expect(verifySignature(Buffer.from(`${raw.toString()} `), sig(raw), secret)).toBe(false);
    expect(verifySignature(raw, sig(raw, 'outro'), secret)).toBe(false);
    expect(verifySignature(raw, undefined, secret)).toBe(false);
    expect(verifySignature(raw, 'sha256=curto', secret)).toBe(false);
    expect(verifySignature(raw, 'md5=' + 'a'.repeat(64), secret)).toBe(false);
    expect(verifySignature(raw, sig(raw), '')).toBe(false);
  });

  it('a verificação usa os bytes originais: o mesmo JSON com espaços diferentes não confere', () => {
    const pretty = Buffer.from(JSON.stringify(fixture('text'), null, 2));
    expect(verifySignature(pretty, sig(raw), secret)).toBe(false);
  });

  it('desafio do GET: eco do challenge só com modo e token corretos', () => {
    const q = { 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '1158201444' };
    expect(verifyChallenge(q, 'tok')).toBe('1158201444');
    expect(verifyChallenge({ ...q, 'hub.verify_token': 'errado' }, 'tok')).toBeNull();
    expect(verifyChallenge({ ...q, 'hub.mode': 'unsubscribe' }, 'tok')).toBeNull();
    expect(verifyChallenge({ ...q, 'hub.challenge': undefined }, 'tok')).toBeNull();
    expect(verifyChallenge(q, '')).toBeNull();
  });
});
