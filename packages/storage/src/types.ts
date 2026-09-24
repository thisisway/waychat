import type { Readable } from 'node:stream';

/** Armazenamento de objetos (S3/MinIO). Chaves são geradas pelo servidor; nunca vêm do cliente. */
export interface ObjectStore {
  /** Cria o bucket se não existir (desenvolvimento). Em produção o bucket é provisionado à parte. */
  ensureBucket?(): Promise<void>;
  /** Formulário POST assinado: o próprio S3 recusa arquivo fora de 1..maxBytes, antes de qualquer byte chegar à API. */
  presignUpload(
    key: string,
    opts: { maxBytes: number; expiresSec?: number },
  ): Promise<{ url: string; fields: Record<string, string> }>;
  /** Tamanho do objeto, ou `null` se ele não existe. */
  head(key: string): Promise<{ size: number } | null>;
  /** Primeiros `bytes` do objeto (para conferir a assinatura do arquivo). */
  readHead(key: string, bytes: number): Promise<Uint8Array>;
  stream(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
  /** URL de download de curta duração; força `attachment` e o tipo detectado (nunca o que o cliente declarou). */
  presignDownload(
    key: string,
    opts: { fileName: string; contentType: string; expiresSec?: number },
  ): Promise<string>;
}

export type ScanVerdict =
  | { status: 'clean' }
  | { status: 'infected'; signature: string }
  | { status: 'error'; reason: string };

/** Antivírus. `error` (indisponível, timeout) NÃO é `clean`: o arquivo fica retido e a varredura é repetida. */
export interface Scanner {
  scan(stream: Readable): Promise<ScanVerdict>;
}
