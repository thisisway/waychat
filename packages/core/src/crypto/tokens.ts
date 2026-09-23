import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token opaco aleatório (base64url). 32 bytes = 256 bits de entropia. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deriva uma chave por finalidade a partir de um segredo (HKDF-SHA256): tokens de tipos diferentes nunca são intercambiáveis. */
export function deriveKey(secret: string, purpose: string): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', secret, 'waychat-v1', purpose, 32));
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
