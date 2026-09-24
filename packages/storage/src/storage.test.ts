import { createServer, type Server } from 'node:net';
import { Readable } from 'node:stream';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createClamdScanner,
  createS3Store,
  detectContentType,
  extensionAllowed,
  sanitizeFileName,
  type ObjectStore,
} from './index.js';

const bytes = (...v: number[]) => new Uint8Array(v);
const ascii = (s: string) => new TextEncoder().encode(s);

describe('assinatura de arquivo', () => {
  it('reconhece os formatos permitidos pelo conteúdo', () => {
    expect(detectContentType(bytes(0xff, 0xd8, 0xff, 0xe0), 'foto.jpg')).toBe('image/jpeg');
    expect(detectContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'a.PNG')).toBe(
      'image/png',
    );
    expect(detectContentType(ascii('%PDF-1.7'), 'contrato.pdf')).toBe('application/pdf');
    expect(detectContentType(ascii('GIF89a....'), 'a.gif')).toBe('image/gif');
    expect(detectContentType(ascii('RIFF\0\0\0\0WEBPVP8 '), 'a.webp')).toBe('image/webp');
    expect(detectContentType(ascii('RIFF\0\0\0\0WAVEfmt '), 'a.wav')).toBe('audio/wav');
    expect(detectContentType(ascii('OggS\0'), 'voz.ogg')).toBe('audio/ogg');
    expect(detectContentType(ascii('\0\0\0\x18ftypisom'), 'v.mp4')).toBe('video/mp4');
    expect(detectContentType(ascii('Olá, mundo\n'), 'nota.txt')).toBe('text/plain');
  });

  it('recusa quando o conteúdo não combina com a extensão declarada', () => {
    // executável do Windows disfarçado de PDF / de imagem
    expect(detectContentType(ascii('MZ\x90\0\x03'), 'fatura.pdf')).toBeNull();
    expect(detectContentType(ascii('MZ\x90\0'), 'foto.png')).toBeNull();
    // PNG legítimo com extensão de PDF
    expect(
      detectContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), 'a.pdf'),
    ).toBeNull();
    // HTML com extensão de texto ainda é texto (vai baixado como attachment); binário com .txt não é
    expect(detectContentType(bytes(0x00, 0x01, 0x02), 'a.txt')).toBeNull();
  });

  it('extensões fora da lista nunca passam, mesmo com conteúdo válido', () => {
    for (const nome of ['a.exe', 'a.html', 'a.svg', 'a.js', 'a.zip', 'a.docm', 'a']) {
      expect(extensionAllowed(nome), nome).toBe(false);
      expect(detectContentType(ascii('%PDF-1.7'), nome), nome).toBeNull();
    }
    expect(extensionAllowed('FOTO.JPEG')).toBe(true);
  });

  it('texto cortado no meio de um caractere UTF-8 ainda é texto', () => {
    const full = new TextEncoder().encode('café');
    expect(detectContentType(full.subarray(0, full.length - 1), 'a.txt')).toBe('text/plain');
  });

  it('sanitiza o nome do arquivo', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\x\\rel"atório<1>.pdf')).toBe('rel_atório_1_.pdf');
    expect(sanitizeFileName('...oculto')).toBe('oculto');
    expect(sanitizeFileName('   ')).toBe('arquivo');
    expect(sanitizeFileName('a\r\nb.txt')).toBe('a__b.txt');
    expect(sanitizeFileName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(120);
  });
});

describe('clamd (INSTREAM)', () => {
  let server: Server;
  let port: number;
  let received: Buffer[] = [];
  let answer = 'stream: OK\0';

  beforeAll(async () => {
    server = createServer((sock) => {
      let buf = Buffer.alloc(0);
      let cmd = false;
      sock.on('data', (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        if (!cmd) {
          const nul = buf.indexOf(0);
          if (nul < 0) return;
          expect(buf.subarray(0, nul).toString()).toBe('zINSTREAM');
          buf = buf.subarray(nul + 1);
          cmd = true;
        }
        // lê blocos [len][dados] até o bloco de tamanho 0
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32BE(0);
          if (len === 0) {
            sock.end(answer);
            return;
          }
          if (buf.length < 4 + len) return;
          received.push(buf.subarray(4, 4 + len));
          buf = buf.subarray(4 + len);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    server.close();
  });

  const scan = (data: Buffer, timeoutMs?: number) =>
    createClamdScanner({ host: '127.0.0.1', port, ...(timeoutMs ? { timeoutMs } : {}) }).scan(
      Readable.from([data]),
    );

  it('arquivo limpo, com todos os bytes entregues ao antivírus', async () => {
    received = [];
    answer = 'stream: OK\0';
    const data = Buffer.from('conteúdo qualquer'.repeat(1000));
    expect(await scan(data)).toEqual({ status: 'clean' });
    expect(Buffer.concat(received).equals(data)).toBe(true);
  });

  it('infectado devolve o nome da assinatura', async () => {
    answer = 'stream: Eicar-Test-Signature FOUND\0';
    expect(await scan(Buffer.from('x'))).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    });
  });

  it('erro do clamd, servidor fora do ar e timeout NUNCA viram "clean"', async () => {
    answer = 'INSTREAM size limit exceeded. ERROR\0';
    expect((await scan(Buffer.from('x'))).status).toBe('error');
    const off = await createClamdScanner({ host: '127.0.0.1', port: 1 }).scan(Readable.from(['x']));
    expect(off.status).toBe('error');
    // servidor que aceita e nunca responde
    const mudo = createServer(() => undefined);
    await new Promise<void>((r) => mudo.listen(0, '127.0.0.1', r));
    const p = (mudo.address() as { port: number }).port;
    const t = await createClamdScanner({ host: '127.0.0.1', port: p, timeoutMs: 200 }).scan(
      Readable.from(['x']),
    );
    expect(t).toEqual({ status: 'error', reason: 'timeout' });
    mudo.close();
  });
});

describe('S3 (MinIO)', () => {
  let minio: StartedTestContainer | undefined;
  let store: ObjectStore;

  beforeAll(async () => {
    const started = await new GenericContainer('minio/minio:latest')
      .withCommand(['server', '/data'])
      .withEnvironment({ MINIO_ROOT_USER: 'teste', MINIO_ROOT_PASSWORD: 'teste-senha-longa' })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forLogMessage(/API: http/))
      .withStartupTimeout(180_000)
      .start();
    minio = started;
    const endpoint = `http://${started.getHost()}:${String(started.getMappedPort(9000))}`;
    const admin = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: 'teste', secretAccessKey: 'teste-senha-longa' },
    });
    await admin.send(new CreateBucketCommand({ Bucket: 'anexos' }));
    store = createS3Store({
      endpoint,
      region: 'us-east-1',
      bucket: 'anexos',
      accessKey: 'teste',
      secretKey: 'teste-senha-longa',
    });
  }, 240_000);
  afterAll(async () => {
    await minio?.stop();
  });

  async function upload(key: string, body: Uint8Array, maxBytes = 1024) {
    const { url, fields } = await store.presignUpload(key, { maxBytes });
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('file', new Blob([Buffer.from(body)]), 'x');
    return fetch(url, { method: 'POST', body: form });
  }

  it('upload direto por formulário assinado, leitura do início, stream e remoção', async () => {
    const data = new TextEncoder().encode('%PDF-1.7 conteúdo de teste');
    const res = await upload('accounts/a/1', data);
    expect(res.status).toBe(204);
    expect(await store.head('accounts/a/1')).toEqual({ size: data.length });
    expect(new TextDecoder().decode(await store.readHead('accounts/a/1', 5))).toBe('%PDF-');
    const chunks: Buffer[] = [];
    for await (const c of await store.stream('accounts/a/1')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toContain('conteúdo de teste');
    await store.remove('accounts/a/1');
    expect(await store.head('accounts/a/1')).toBeNull();
  });

  it('o S3 recusa arquivo maior que o limite assinado e chave diferente da assinada', async () => {
    const big = await upload('accounts/a/2', new Uint8Array(2048), 1024);
    expect(big.status).toBeGreaterThanOrEqual(400);
    expect(await store.head('accounts/a/2')).toBeNull();

    const { url, fields } = await store.presignUpload('accounts/a/3', { maxBytes: 1024 });
    const form = new FormData();
    for (const [k, v] of Object.entries({ ...fields, key: 'accounts/b/outra-chave' }))
      form.append(k, v);
    form.append('file', new Blob(['oi']), 'x');
    expect((await fetch(url, { method: 'POST', body: form })).status).toBeGreaterThanOrEqual(400);
  });

  it('URL de download força attachment e o tipo detectado', async () => {
    await upload(
      'accounts/a/4',
      new TextEncoder().encode('<html><script>alert(1)</script></html>'),
    );
    const url = await store.presignDownload('accounts/a/4', {
      fileName: 'relatório final.txt',
      contentType: 'text/plain',
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('content-disposition')).toContain('relat%C3%B3rio%20final.txt');
  });
});
