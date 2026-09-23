import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Cifra segredos de integração/MFA com AES-256-GCM.
 * Formato: `v1.<kid>.<iv>.<tag>.<ciphertext>` (base64url). `kid` identifica a chave, permitindo rotação:
 * cifra sempre com a chave atual e decifra com qualquer chave do chaveiro (atual + anteriores).
 * `aad` amarra o texto cifrado ao contexto (ex.: `mfa:<userId>`): copiar o valor para outra linha faz a decifragem falhar.
 */
const TAG_LENGTH = 16;

export class Keyring {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKid: string;

  constructor(currentBase64: string, previousBase64: readonly string[] = []) {
    const current = Keyring.load(currentBase64);
    this.currentKid = current.kid;
    this.keys.set(current.kid, current.key);
    for (const p of previousBase64) {
      const k = Keyring.load(p);
      this.keys.set(k.kid, k.key);
    }
  }

  private static load(base64: string): { kid: string; key: Buffer } {
    const key = Buffer.from(base64, 'base64');
    if (key.length !== 32) throw new Error('chave mestra deve ter 32 bytes');
    return { kid: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.keys.get(this.currentKid);
    if (!key) throw new Error('chave atual ausente');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', this.currentKid, iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(payload: string, aad: string): string {
    const [version, kid, iv, tag, ct] = payload.split('.');
    if (version !== 'v1' || !kid || !iv || !tag || !ct)
      throw new Error('formato de segredo inválido');
    const key = this.keys.get(kid);
    if (!key) throw new Error('chave de cifragem desconhecida (rotação incompleta?)');
    const tagBytes = Buffer.from(tag, 'base64url');
    // Sem exigir 16 bytes, um atacante poderia enviar uma tag curta e forjar o texto cifrado.
    if (tagBytes.length !== TAG_LENGTH) throw new Error('tag de autenticação inválida');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([
      decipher.update(Buffer.from(ct, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** True se o segredo foi cifrado com uma chave que não é a atual (candidato a recifragem). */
  needsRotation(payload: string): boolean {
    return payload.split('.')[1] !== this.currentKid;
  }
}
