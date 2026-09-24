import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { useAttachmentDrafts } from './attachments.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const att = (status: string, id = 'srv-1') => ({
  id,
  fileName: 'a.png',
  contentType: 'image/png',
  size: 5,
  status,
});

let fetchMock: Mock<typeof fetch>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const file = (name = 'a.png', size = 5) => new File([new Uint8Array(size)], name);

describe('rascunho de anexos', () => {
  it('fluxo: URL assinada → envio ao S3 → conclusão → varredura → pronto', async () => {
    let scans = 0;
    fetchMock.mockImplementation((url, init) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (u === 'https://s3.test/bucket') {
        const form = init?.body as FormData;
        expect([...form.keys()]).toEqual(['key', 'file']); // campos assinados primeiro, arquivo por último
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (u.endsWith('/conversations/c1/attachments'))
        return Promise.resolve(
          json(201, {
            attachment: att('awaiting_upload'),
            upload: { url: 'https://s3.test/bucket', fields: { key: 'k' } },
          }),
        );
      if (u.endsWith('/attachments/srv-1/complete'))
        return Promise.resolve(json(200, { attachment: att('scanning') }));
      if (u.endsWith('/attachments/srv-1')) {
        scans += 1;
        return Promise.resolve(json(200, { attachment: att(scans < 2 ? 'scanning' : 'clean') }));
      }
      return Promise.resolve(json(404, {}));
    });
    const { result } = renderHook(() => useAttachmentDrafts('c1'));
    act(() => {
      result.current.attach([file()]);
    });
    expect(result.current.drafts[0]?.status).toBe('uploading');
    await waitFor(
      () => expect(result.current.drafts[0]).toMatchObject({ id: 'srv-1', status: 'ready' }),
      {
        timeout: 5000,
      },
    );
  });

  it('extensão proibida, arquivo vazio e grande demais falham sem chamar a rede', () => {
    const { result } = renderHook(() => useAttachmentDrafts('c1'));
    act(() => {
      result.current.attach([
        file('v.exe'),
        file('a.png', 0),
        { name: 'g.png', size: 11 * 1024 * 1024 } as File,
      ]);
    });
    expect(result.current.drafts.map((d) => d.error)).toEqual([
      'Tipo não permitido',
      'Arquivo vazio',
      'Maior que 10 MB',
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falha do S3 marca erro; remover tira do rascunho; no máximo 5', async () => {
    fetchMock.mockImplementation((url) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (u === 'https://s3.test/bucket')
        return Promise.resolve(new Response('x', { status: 403 }));
      return Promise.resolve(
        json(201, {
          attachment: att('awaiting_upload'),
          upload: { url: 'https://s3.test/bucket', fields: { key: 'k' } },
        }),
      );
    });
    const { result } = renderHook(() => useAttachmentDrafts('c1'));
    act(() => {
      result.current.attach([file()]);
    });
    await waitFor(() => expect(result.current.drafts[0]?.status).toBe('error'));
    act(() => {
      result.current.remove(result.current.drafts[0]?.id ?? '');
    });
    expect(result.current.drafts).toHaveLength(0);
    act(() => {
      result.current.attach(Array.from({ length: 7 }, () => file('v.exe')));
    });
    expect(result.current.drafts).toHaveLength(5);
  });
});
