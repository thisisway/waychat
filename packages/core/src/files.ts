import type { Env } from '@waychat/shared';
import { createClamdScanner, createS3Store } from '@waychat/storage';
import type { FileServices } from './context.js';

/**
 * Armazenamento + antivírus a partir do ambiente. Em produção o antivírus é obrigatório: sem `CLAMAV_HOST`
 * a subida falha, em vez de aceitar arquivos sem varredura.
 */
export function fileServicesFromEnv(
  env: Pick<
    Env,
    | 'NODE_ENV'
    | 'S3_ENDPOINT'
    | 'S3_PUBLIC_ENDPOINT'
    | 'S3_REGION'
    | 'S3_BUCKET'
    | 'S3_ACCESS_KEY'
    | 'S3_SECRET_KEY'
    | 'CLAMAV_HOST'
    | 'CLAMAV_PORT'
  >,
  enqueueScan: FileServices['enqueueScan'],
): FileServices {
  if (env.NODE_ENV === 'production' && !env.CLAMAV_HOST) {
    throw new Error(
      'CLAMAV_HOST é obrigatório em produção: anexos não podem ser aceitos sem varredura',
    );
  }
  return {
    store: createS3Store({
      endpoint: env.S3_ENDPOINT,
      ...(env.S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.S3_PUBLIC_ENDPOINT } : {}),
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    }),
    scanner: env.CLAMAV_HOST
      ? createClamdScanner({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT })
      : null,
    enqueueScan,
  };
}
