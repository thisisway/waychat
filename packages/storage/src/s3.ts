import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  NoSuchKey,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'node:stream';
import type { ObjectStore } from './types.js';

export interface S3Options {
  endpoint: string;
  /** Endpoint que o NAVEGADOR alcança (URLs assinadas). Padrão: o mesmo `endpoint`. */
  publicEndpoint?: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export function createS3Store(o: S3Options): ObjectStore {
  const cfg = (endpoint: string) => ({
    endpoint,
    region: o.region,
    forcePathStyle: true, // MinIO e a maioria dos S3 compatíveis
    credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey },
  });
  const internal = new S3Client(cfg(o.endpoint));
  const external = o.publicEndpoint ? new S3Client(cfg(o.publicEndpoint)) : internal;
  const Bucket = o.bucket;

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket }));
      } catch {
        await internal.send(new CreateBucketCommand({ Bucket }));
      }
    },
    async presignUpload(key, { maxBytes, expiresSec = 600 }) {
      const { url, fields } = await createPresignedPost(external, {
        Bucket,
        Key: key,
        Expires: expiresSec,
        Conditions: [['content-length-range', 1, maxBytes]],
      });
      return { url, fields };
    },
    async head(key) {
      try {
        const r = await internal.send(new HeadObjectCommand({ Bucket, Key: key }));
        return { size: r.ContentLength ?? 0 };
      } catch (e) {
        if (e instanceof NotFound || e instanceof NoSuchKey) return null;
        throw e;
      }
    },
    async readHead(key, bytes) {
      const r = await internal.send(
        new GetObjectCommand({ Bucket, Key: key, Range: `bytes=0-${String(bytes - 1)}` }),
      );
      return r.Body ? await r.Body.transformToByteArray() : new Uint8Array();
    },
    async stream(key) {
      const r = await internal.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!(r.Body instanceof Readable)) throw new Error('corpo do objeto não é um stream');
      return r.Body;
    },
    async remove(key) {
      await internal.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    presignDownload(key, { fileName, contentType, expiresSec = 300 }) {
      // filename* (RFC 5987) aceita acentos; o nome já foi sanitizado ao registrar o anexo
      const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
      return getSignedUrl(
        external,
        new GetObjectCommand({
          Bucket,
          Key: key,
          ResponseContentDisposition: disposition,
          ResponseContentType: contentType,
        }),
        { expiresIn: expiresSec },
      );
    },
  };
}
