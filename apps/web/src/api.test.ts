import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { api, ApiError } from './api.js';
import { messageTime, shortTime } from './format.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let fetchMock: Mock<typeof fetch>;

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
  document.cookie = 'wc_csrf=token-de-teste; path=/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'wc_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
});

const headersOf = (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers;

describe('cliente da API', () => {
  it('envia o token CSRF em requisições que mudam estado e não no GET', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, { ok: true })));
    await api('GET', '/auth/me');
    await api('POST', '/conversations/1/read');
    expect(headersOf(fetchMock.mock.calls[0] ?? [])['x-csrf-token']).toBeUndefined();
    expect(headersOf(fetchMock.mock.calls[1] ?? [])['x-csrf-token']).toBe('token-de-teste');
  });

  it('inclui os cookies de sessão (credentials: include)', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));
    await api('GET', '/auth/me');
    expect((fetchMock.mock.calls[0]?.[1] as { credentials: string }).credentials).toBe('include');
  });

  it('401 renova a sessão UMA vez e repete a requisição', async () => {
    fetchMock
      .mockResolvedValueOnce(json(401, { error: { code: 'invalid_token', message: 'x' } }))
      .mockResolvedValueOnce(json(200, { ok: true })) // /auth/refresh
      .mockResolvedValueOnce(json(200, { nome: 'ok' }));
    expect(await api('GET', '/conversations')).toEqual({ nome: 'ok' });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/conversations',
      '/auth/refresh',
      '/conversations',
    ]);
  });

  it('várias requisições com 401 ao mesmo tempo compartilham UMA renovação (single-flight)', async () => {
    let refreshes = 0;
    let refreshed = false;
    fetchMock.mockImplementation((url) => {
      if (url === '/auth/refresh') {
        refreshes++;
        refreshed = true;
        return Promise.resolve(json(200, { ok: true }));
      }
      return Promise.resolve(
        refreshed
          ? json(200, { ok: true })
          : json(401, { error: { code: 'invalid_token', message: 'x' } }),
      );
    });
    await Promise.all([api('GET', '/a'), api('GET', '/b'), api('GET', '/c')]);
    expect(refreshes).toBe(1);
  });

  it('se a renovação falha, o erro 401 chega ao chamador', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json(401, { error: { code: 'invalid_token', message: 'Sessão expirada.' } }),
      )
      .mockResolvedValueOnce(json(401, { error: { code: 'invalid_token', message: 'x' } })) // refresh
      .mockResolvedValueOnce(
        json(401, { error: { code: 'invalid_token', message: 'Sessão expirada.' } }),
      );
    await expect(api('GET', '/conversations')).rejects.toMatchObject({
      status: 401,
      code: 'invalid_token',
    });
  });

  it('login com senha errada não tenta renovar a sessão', async () => {
    fetchMock.mockResolvedValue(
      json(401, { error: { code: 'invalid_credentials', message: 'E-mail ou senha inválidos.' } }),
    );
    await expect(api('POST', '/auth/login', { email: 'a@b.com', password: 'x' })).rejects.toThrow(
      'E-mail ou senha inválidos.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('traduz o corpo de erro padrão da API em ApiError', async () => {
    fetchMock.mockResolvedValue(
      json(409, {
        error: { code: 'last_owner', message: 'A conta precisa de pelo menos um Owner.' },
      }),
    );
    const err = await api('DELETE', '/members/1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'last_owner' });
  });
});

describe('formatação de horários', () => {
  const now = new Date('2026-09-23T15:00:00');
  it('hoje mostra só a hora; outro dia mostra a data', () => {
    expect(shortTime('2026-09-23T09:05:00', now)).toBe('09:05');
    expect(shortTime('2026-09-20T09:05:00', now)).toBe('20/09');
  });
  it('dentro da conversa outro dia mostra data e hora', () => {
    expect(messageTime('2026-09-23T14:32:00', now)).toBe('14:32');
    expect(messageTime('2026-09-20T14:32:00', now)).toBe('20/09 14:32');
  });
});
