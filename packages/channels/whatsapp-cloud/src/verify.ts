import { createHmac, timingSafeEqual } from 'node:crypto';

const same = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/**
 * Confere `X-Hub-Signature-256` (`sha256=<hex>`): HMAC-SHA256 do corpo BRUTO com o App Secret.
 * Qualquer problema (cabeçalho ausente, formato, tamanho) devolve `false`; nunca lança.
 */
export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m?.[1]) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return same(expected, m[1].toLowerCase());
}

/** Verificação do endpoint (GET): devolve o `hub.challenge` a ecoar, ou `null` se o modo ou o token não conferem. */
export function verifyChallenge(
  query: Record<string, string | undefined>,
  verifyToken: string,
): string | null {
  const challenge = query['hub.challenge'];
  const token = query['hub.verify_token'];
  if (query['hub.mode'] !== 'subscribe' || !token || !verifyToken || challenge === undefined)
    return null;
  return same(token, verifyToken) ? challenge : null;
}
