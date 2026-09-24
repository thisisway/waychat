import { Readable } from 'node:stream';
import type { FileServices } from '@waychat/core';
import type { ObjectStore, ScanVerdict } from '@waychat/storage';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** Armazenamento em memória: o teste "faz o upload" gravando direto no mapa, no lugar do navegador. */
export class MemStore implements ObjectStore {
  objects = new Map<string, Uint8Array>();
  lastKey = '';
  presignUpload(key: string) {
    this.lastKey = key;
    return Promise.resolve({ url: 'http://s3.test/bucket', fields: { key } });
  }
  head(key: string) {
    const o = this.objects.get(key);
    return Promise.resolve(o ? { size: o.length } : null);
  }
  readHead(key: string, bytes: number) {
    return Promise.resolve((this.objects.get(key) ?? new Uint8Array()).subarray(0, bytes));
  }
  stream(key: string) {
    return Promise.resolve(Readable.from([Buffer.from(this.objects.get(key) ?? [])]));
  }
  remove(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  presignDownload(key: string, opts: { fileName: string }) {
    return Promise.resolve(`http://s3.test/${key}?name=${encodeURIComponent(opts.fileName)}`);
  }
}

/** Serviços de arquivo de teste: varredura "manual" (o teste chama `scanAttachment` no lugar do worker). */
export function testFiles(): { files: FileServices; store: MemStore; verdict: { v: ScanVerdict } } {
  const store = new MemStore();
  const verdict: { v: ScanVerdict } = { v: { status: 'clean' } };
  return {
    store,
    verdict,
    files: {
      store,
      scanner: { scan: () => Promise.resolve(verdict.v) },
      enqueueScan: () => Promise.resolve(),
    },
  };
}
