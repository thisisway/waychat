import type { OutboundMessage } from '@waychat/channels';
import { describe, expect, it, vi } from 'vitest';
import { classifyError, GraphError, send, type GraphConfig } from './index.js';

const cfg = (fetch: typeof globalThis.fetch): GraphConfig => ({
  accessToken: 'token-de-teste',
  version: 'v23.0',
  baseUrl: 'https://graph.test',
  fetch,
});

const ok = (id = 'wamid.OUT1') =>
  Promise.resolve(new Response(JSON.stringify({ messages: [{ id }] }), { status: 200 }));

const base: Omit<OutboundMessage, 'content'> = { to: '5511988887777', opaque: 'msg-local-1' };

function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('send: envelope comum', () => {
  it('manda messaging_product, to, o opaque em biz_opaque_callback_data e o contexto da citação', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => ok());
    const result = await send(
      { ...base, replyToProviderId: 'wamid.ORIGINAL', content: { type: 'text', body: 'Olá' } },
      cfg(fetch),
    );
    expect(result).toEqual({ providerMessageId: 'wamid.OUT1' });
    const body = sentBody(fetch);
    expect(body).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511988887777',
      biz_opaque_callback_data: 'msg-local-1',
      context: { message_id: 'wamid.ORIGINAL' },
      type: 'text',
      text: { body: 'Olá', preview_url: false },
    });
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toBe('https://graph.test/v23.0/messages');
  });

  it('sem resposta apontando o id da mensagem, lança (a Meta sempre devolve isso em sucesso)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(
      send({ ...base, content: { type: 'text', body: 'x' } }, cfg(fetch)),
    ).rejects.toThrow();
  });

  it('erro da Graph API propaga como GraphError (quem chama classifica)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 131047, message: 'janela fechada' } }), {
          status: 400,
        }),
      ),
    );
    const err = await send({ ...base, content: { type: 'text', body: 'x' } }, cfg(fetch)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GraphError);
    expect(classifyError(err)).toMatchObject({ retryable: false, code: 'window_closed' });
  });
});

describe('send: tipos de conteúdo', () => {
  const captured = async (contentArg: OutboundMessage['content']) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => ok());
    await send({ ...base, content: contentArg }, cfg(fetch));
    return sentBody(fetch);
  };

  it('imagem por id, com legenda; vídeo/figurinha sem legenda', async () => {
    expect(await captured({ type: 'image', media: { id: '9001' }, caption: 'Foto' })).toMatchObject(
      {
        type: 'image',
        image: { id: '9001', caption: 'Foto' },
      },
    );
    expect(await captured({ type: 'sticker', media: { link: 'https://x/y.webp' } })).toMatchObject({
      type: 'sticker',
      sticker: { link: 'https://x/y.webp' },
    });
  });

  it('documento leva filename e legenda quando informados', async () => {
    expect(
      await captured({
        type: 'document',
        media: { id: '1' },
        fileName: 'contrato.pdf',
        caption: 'Segue',
      }),
    ).toMatchObject({
      type: 'document',
      document: { id: '1', filename: 'contrato.pdf', caption: 'Segue' },
    });
  });

  it('áudio nunca leva legenda (a Cloud API não aceita)', async () => {
    const body = await captured({ type: 'audio', media: { id: '1' } });
    expect(body['audio']).toEqual({ id: '1' });
  });

  it('localização com e sem nome/endereço', async () => {
    expect(
      await captured({ type: 'location', latitude: -23.5, longitude: -46.6, name: 'Sé' }),
    ).toMatchObject({
      type: 'location',
      location: { latitude: -23.5, longitude: -46.6, name: 'Sé' },
    });
  });

  it('contatos: nosso formato vira o objeto de contato da Meta', async () => {
    const body = await captured({
      type: 'contacts',
      contacts: [
        {
          name: 'João',
          phones: [{ phone: '+55 11 1111', waId: '551111', kind: 'CELL' }],
          emails: ['j@x.com'],
        },
      ],
    });
    expect(body['contacts']).toEqual([
      {
        name: { formatted_name: 'João' },
        phones: [{ phone: '+55 11 1111', wa_id: '551111', type: 'CELL' }],
        emails: [{ email: 'j@x.com' }],
      },
    ]);
  });

  it('reação com emoji, e remoção com string vazia (nunca null)', async () => {
    expect(
      await captured({ type: 'reaction', targetProviderId: 'wamid.X', emoji: '👍' }),
    ).toMatchObject({
      reaction: { message_id: 'wamid.X', emoji: '👍' },
    });
    expect(
      await captured({ type: 'reaction', targetProviderId: 'wamid.X', emoji: null }),
    ).toMatchObject({
      reaction: { message_id: 'wamid.X', emoji: '' },
    });
  });

  it('botões interativos, lista e CTA URL', async () => {
    expect(
      await captured({
        type: 'interactive_buttons',
        body: 'Confirma?',
        buttons: [{ id: 'a', title: 'Sim' }],
      }),
    ).toMatchObject({
      interactive: {
        type: 'button',
        body: { text: 'Confirma?' },
        action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'Sim' } }] },
      },
    });
    expect(
      await captured({
        type: 'interactive_list',
        body: 'Escolha',
        buttonLabel: 'Ver opções',
        sections: [
          { title: 'Planos', rows: [{ id: 'p1', title: 'Básico', description: 'R$ 10' }] },
        ],
      }),
    ).toMatchObject({
      interactive: {
        type: 'list',
        action: {
          button: 'Ver opções',
          sections: [
            { title: 'Planos', rows: [{ id: 'p1', title: 'Básico', description: 'R$ 10' }] },
          ],
        },
      },
    });
    expect(
      await captured({
        type: 'interactive_cta_url',
        body: 'Acesse',
        label: 'Abrir',
        url: 'https://x.com',
      }),
    ).toMatchObject({
      interactive: {
        type: 'cta_url',
        action: { name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://x.com' } },
      },
    });
  });

  it('template: nome, idioma, cabeçalho de mídia, variáveis do corpo e botão de resposta rápida', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => ok());
    await send(
      {
        ...base,
        content: {
          type: 'template',
          name: 'confirmacao_pedido',
          language: 'pt_BR',
          components: [
            { type: 'header', parameters: [{ type: 'image', media: { id: 'media-1' } }] },
            {
              type: 'body',
              parameters: [
                { type: 'text', text: 'Maria' },
                { type: 'text', text: '#123' },
              ],
            },
            {
              type: 'button',
              index: 0,
              subType: 'quick_reply',
              parameters: [{ type: 'payload', payload: 'confirmar-123' }],
            },
          ],
        },
      },
      cfg(fetch),
    );
    const body = sentBody(fetch);
    expect(body).toMatchObject({
      type: 'template',
      template: {
        name: 'confirmacao_pedido',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'image', image: { id: 'media-1' } }] },
          {
            type: 'body',
            parameters: [
              { type: 'text', text: 'Maria' },
              { type: 'text', text: '#123' },
            ],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'confirmar-123' }],
          },
        ],
      },
    });
  });
});
