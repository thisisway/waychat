export { createClamdScanner, type ClamdOptions } from './clamav.js';
export {
  allowedExtensions,
  detectContentType,
  extensionAllowed,
  MAX_ATTACHMENT_BYTES,
  sanitizeFileName,
} from './magic.js';
export { createS3Store, type S3Options } from './s3.js';
export type { ObjectStore, Scanner, ScanVerdict } from './types.js';
export {
  createScanQueue,
  enqueueScan,
  SCAN_QUEUE,
  startScanWorker,
  type ScanJob,
} from './scan-queue.js';
