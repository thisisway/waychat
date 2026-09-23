import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Ctx } from '../../../context.js';
import { deriveKey } from '../../../crypto/tokens.js';
import { DomainError } from '../../../errors.js';

const ISSUER = 'waychat';

const accessClaims = z.object({
  sub: z.uuid(),
  acc: z.uuid(),
  fam: z.uuid(),
  mfa: z.boolean(),
});
export type AccessClaims = z.infer<typeof accessClaims>;

const challengeClaims = z.object({
  sub: z.uuid(),
  acc: z.uuid(),
  purpose: z.enum(['mfa', 'enroll']),
});
export type ChallengeClaims = z.infer<typeof challengeClaims>;
export type ChallengePurpose = ChallengeClaims['purpose'];

// Chaves distintas por finalidade (HKDF): um challenge nunca vale como access token e vice-versa.
const accessKey = (ctx: Ctx) => deriveKey(ctx.config.sessionSecret, 'access-token');
const challengeKey = (ctx: Ctx) => deriveKey(ctx.config.sessionSecret, 'mfa-challenge');

function seconds(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

export async function signAccessToken(
  ctx: Ctx,
  claims: AccessClaims,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = seconds(ctx.now());
  const exp = iat + ctx.config.accessTtlSeconds;
  const token = await new SignJWT({ acc: claims.acc, fam: claims.fam, mfa: claims.mfa })
    .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience('waychat:access')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(accessKey(ctx));
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyAccessToken(ctx: Ctx, token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, accessKey(ctx), {
      issuer: ISSUER,
      audience: 'waychat:access',
      algorithms: ['HS256'],
      currentDate: ctx.now(),
    });
    return accessClaims.parse(payload);
  } catch {
    throw new DomainError('invalid_token');
  }
}

export async function signChallenge(ctx: Ctx, claims: ChallengeClaims): Promise<string> {
  const iat = seconds(ctx.now());
  return new SignJWT({ acc: claims.acc, purpose: claims.purpose })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience('waychat:challenge')
    .setIssuedAt(iat)
    .setExpirationTime(iat + ctx.config.challengeTtlSeconds)
    .sign(challengeKey(ctx));
}

export async function verifyChallenge(
  ctx: Ctx,
  token: string,
  purpose: ChallengePurpose,
): Promise<ChallengeClaims> {
  try {
    const { payload } = await jwtVerify(token, challengeKey(ctx), {
      issuer: ISSUER,
      audience: 'waychat:challenge',
      algorithms: ['HS256'],
      currentDate: ctx.now(),
    });
    const claims = challengeClaims.parse(payload);
    if (claims.purpose !== purpose) throw new Error('purpose');
    return claims;
  } catch {
    throw new DomainError('invalid_token');
  }
}
