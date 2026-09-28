import { describe, expect, it, vi } from 'vitest';
import {
  createTemplate,
  listTemplates,
  normalizeTemplateStatus,
  type GraphConfig,
} from './index.js';

const cfg = (fetch: typeof globalThis.fetch): GraphConfig => ({
  accessToken: 'token-de-teste',
  version: 'v23.0',
  baseUrl: 'https://graph.test',
  fetch,
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

describe('listTemplates', () => {
  it('monta a URL com os campos certos e devolve os dados', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      json({
        data: [
          {
            id: '1',
            name: 'boas_vindas',
            language: 'pt_BR',
            category: 'UTILITY',
            status: 'APPROVED',
            components: [],
          },
        ],
      }),
    );
    const out = await listTemplates(cfg(fetch), 'waba-1');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: '1', name: 'boas_vindas', status: 'APPROVED' });
    const [url] = fetch.mock.calls[0] as [string];
    expect(url).toBe(
      'https://graph.test/v23.0/waba-1/message_templates?fields=id,name,language,category,status,components,rejected_reason&limit=100',
    );
  });

  it('segue a paginação até `paging.next` não existir mais', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        await json({
          data: [
            {
              id: '1',
              name: 'a',
              language: 'pt_BR',
              category: 'UTILITY',
              status: 'APPROVED',
              components: [],
            },
          ],
          paging: { next: 'https://graph.test/v23.0/waba-1/message_templates?after=abc' },
        }),
      )
      .mockResolvedValueOnce(
        await json({
          data: [
            {
              id: '2',
              name: 'b',
              language: 'pt_BR',
              category: 'UTILITY',
              status: 'PENDING',
              components: [],
            },
          ],
        }),
      );
    const out = await listTemplates(cfg(fetch), 'waba-1');
    expect(out.map((t) => t.id)).toEqual(['1', '2']);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [secondUrl] = fetch.mock.calls[1] as [string];
    expect(secondUrl).toBe('https://graph.test/v23.0/waba-1/message_templates?after=abc'); // URL absoluta da própria Meta
  });
});

describe('normalizeTemplateStatus', () => {
  it('mapeia os status conhecidos (maiúsculas ou minúsculas) e cai em "other" para o resto', () => {
    expect(normalizeTemplateStatus('APPROVED')).toBe('approved');
    expect(normalizeTemplateStatus('paused')).toBe('paused');
    expect(normalizeTemplateStatus('PENDING_DELETION')).toBe('other');
  });
});

describe('createTemplate', () => {
  it('faz POST com nome, idioma, categoria e componentes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      json({ id: '99', status: 'PENDING', category: 'UTILITY' }),
    );
    const result = await createTemplate(cfg(fetch), 'waba-1', {
      name: 'confirmacao',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Olá {{1}}' }],
    });
    expect(result).toEqual({ id: '99', status: 'PENDING', category: 'UTILITY' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.test/v23.0/waba-1/message_templates');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'confirmacao',
      language: 'pt_BR',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Olá {{1}}' }],
    });
  });
});
