import { describe, expect, it, vi } from 'vitest';
import { fetchMedia, GraphError, graphRequest, type GraphConfig } from './index.js';

const cfg = (fetch: typeof globalThis.fetch, over: Partial<GraphConfig> = {}): GraphConfig => ({
  accessToken: 'token-de-teste',
  version: 'v23.0',
  baseUrl: 'https://graph.test',
  fetch,
  ...over,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('graphRequest', () => {
  it('monta a URL com versão e base, e manda o Bearer', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => json({ ok: true }));
    await graphRequest(cfg(fetch), 'messages');
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.test/v23.0/messages');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer token-de-teste');
  });

  it('URL absoluta ignora a base (usada para baixar mídia)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => json({ ok: true }));
    await graphRequest(cfg(fetch), 'https://lookaside.test/media/x', { absolute: true });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://lookaside.test/media/x');
  });

  it('POST com corpo manda content-type e JSON serializado', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => json({ id: '1' }));
    await graphRequest(cfg(fetch), 'messages', { method: 'POST', body: { to: '123' } });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ to: '123' }));
  });

  it('erro da Graph API vira GraphError com código, mensagem e detalhe', async () => {
    const fetch = vi.fn(() =>
      json(
        {
          error: {
            code: 131047,
            message: 'Re-engagement message',
            error_data: { details: 'janela fechada' },
          },
        },
        400,
      ),
    );
    const err = await graphRequest(cfg(fetch), 'messages').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err).toMatchObject({
      status: 400,
      code: 131047,
      message: 'Re-engagement message',
      details: 'janela fechada',
    });
  });

  it('resposta de erro sem JSON válido ainda vira GraphError com o status', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('gateway timeout', { status: 502 })));
    const err = await graphRequest(cfg(fetch), 'messages').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(502);
    expect((err as GraphError).code).toBeNull();
  });

  it('falha de rede vira GraphError com status 0', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED')));
    const err = await graphRequest(cfg(fetch), 'messages').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(0);
    expect((err as GraphError).message).toContain('ECONNREFUSED');
  });
});

describe('fetchMedia', () => {
  const mediaMeta = (over: Record<string, unknown> = {}) => ({
    url: 'https://lookaside.test/media/9001',
    mime_type: 'image/jpeg',
    file_size: 1000,
    ...over,
  });

  it('baixa em dois passos: metadados e depois os bytes, com o mesmo token', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetch = vi.fn((url: string) => {
      if (url.startsWith('https://graph.test/')) return json(mediaMeta());
      if (url === 'https://lookaside.test/media/9001')
        return Promise.resolve(new Response(bytes, { status: 200 }));
      return json({}, 404);
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchMedia(cfg(fetch), '9001', 10_000);
    expect(result.mimeType).toBe('image/jpeg');
    expect([...result.data]).toEqual([1, 2, 3, 4]);
    for (const call of (fetch as ReturnType<typeof vi.fn>).mock.calls) {
      expect((call[1] as RequestInit).headers).toMatchObject({
        authorization: 'Bearer token-de-teste',
      });
    }
  });

  it('id de mídia com formato inválido nunca chega a fazer requisição', async () => {
    const fetch = vi.fn();
    await expect(
      fetchMedia(cfg(fetch as unknown as typeof globalThis.fetch), 'não-é-um-id', 1000),
    ).rejects.toBeInstanceOf(GraphError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('recusa pelo tamanho ANUNCIADO, sem baixar o corpo', async () => {
    const fetch = vi.fn((url: string) =>
      url.startsWith('https://graph.test/')
        ? json(mediaMeta({ file_size: 999_999 }))
        : json({}, 404),
    ) as unknown as typeof globalThis.fetch;
    const err = await fetchMedia(cfg(fetch), '9001', 1000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect((err as GraphError).status).toBe(413);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1); // só o passo dos metadados
  });

  it('o tamanho anunciado pode mentir: o download é interrompido se passar do limite de verdade', async () => {
    const big = new Uint8Array(2000);
    const fetch = vi.fn((url: string) => {
      if (url.startsWith('https://graph.test/')) return json(mediaMeta({ file_size: 10 })); // mente
      return Promise.resolve(new Response(big, { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await expect(fetchMedia(cfg(fetch), '9001', 1000)).rejects.toMatchObject({ status: 413 });
  });

  it('metadados incompletos (sem url ou mime_type) falham', async () => {
    const fetch = vi.fn((url: string) =>
      url.startsWith('https://graph.test/') ? json({ mime_type: 'image/jpeg' }) : json({}, 404),
    ) as unknown as typeof globalThis.fetch;
    await expect(fetchMedia(cfg(fetch), '9001', 1000)).rejects.toBeInstanceOf(GraphError);
  });
});
