import { describe, expect, it } from 'vitest';
import { isUuidv7, uuidv7 } from './id.js';

describe('uuidv7', () => {
  it('gera UUID v7 válido', () => {
    expect(isUuidv7(uuidv7())).toBe(true);
  });

  it('é ordenável por tempo', () => {
    const ids = [1_000, 2_000, 3_000].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });

  it('não repete ids no mesmo milissegundo', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(5_000)));
    expect(ids.size).toBe(1000);
  });

  it('rejeita UUID v4', () => {
    expect(isUuidv7('3f2b8a4e-5c1d-4e6f-9a7b-1c2d3e4f5a6b')).toBe(false);
  });
});
