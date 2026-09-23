import { randomBytes } from 'node:crypto';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** UUID v7 (RFC 9562): 48 bits de timestamp em ms + aleatório. Ordenável por tempo de criação. */
export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b.writeUInt8((b.readUInt8(6) & 0x0f) | 0x70, 6);
  b.writeUInt8((b.readUInt8(8) & 0x3f) | 0x80, 8);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isUuidv7(value: string): boolean {
  return UUID_V7.test(value);
}
