import { connect } from 'node:net';
import type { Scanner, ScanVerdict } from './types.js';

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs?: number;
}

/**
 * Cliente do protocolo INSTREAM do clamd: `zINSTREAM\0`, depois blocos `[4 bytes big-endian: tamanho][dados]`,
 * terminando com um bloco de tamanho 0. A resposta é `stream: OK` ou `stream: <assinatura> FOUND`.
 */
export function createClamdScanner(opts: ClamdOptions): Scanner {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return {
    scan: (input) =>
      new Promise<ScanVerdict>((resolve) => {
        const socket = connect({ host: opts.host, port: opts.port });
        let settled = false;
        const done = (v: ScanVerdict) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          input.destroy();
          resolve(v);
        };
        socket.setTimeout(timeoutMs, () => {
          done({ status: 'error', reason: 'timeout' });
        });
        socket.on('error', (e) => {
          done({ status: 'error', reason: e.message });
        });
        let reply = '';
        socket.on('data', (d) => {
          reply += d.toString('utf8');
        });
        socket.on('close', () => {
          const text = reply.replaceAll('\0', '').trim();
          if (text.endsWith('OK')) done({ status: 'clean' });
          else if (text.endsWith('FOUND'))
            done({
              status: 'infected',
              signature: text.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''),
            });
          else done({ status: 'error', reason: text || 'resposta vazia do clamd' });
        });
        socket.on('connect', () => {
          socket.write('zINSTREAM\0');
          input.on('data', (chunk: Buffer) => {
            const size = Buffer.alloc(4);
            size.writeUInt32BE(chunk.length);
            socket.write(size);
            socket.write(chunk);
          });
          input.on('end', () => {
            socket.write(Buffer.alloc(4)); // bloco final de tamanho 0
          });
          input.on('error', (e: Error) => {
            done({ status: 'error', reason: e.message });
          });
        });
      }),
  };
}
