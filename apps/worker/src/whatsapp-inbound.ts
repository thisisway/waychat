import type { InboundJob, MediaRef } from '@waychat/channels';
import { startInboundWorker } from '@waychat/channels';
import { fetchMedia, type GraphConfig } from '@waychat/channels-whatsapp';
import {
  loadInboundEvent,
  loadWhatsAppTarget,
  markInboundEventProcessed,
  processWhatsAppEvent,
  type Ctx,
} from '@waychat/core';
import { MAX_ATTACHMENT_BYTES } from '@waychat/storage';
import type { ConnectionOptions } from 'bullmq';

export interface GraphEnv {
  version: string;
  baseUrl: string;
  /** Injetável para teste; padrão é o `fetch` global. */
  fetch?: typeof fetch;
}

/** WhatsApp não declara extensão: deriva do tipo que a própria Meta informou (documentos costumam trazer `fileName`). */
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

function fileNameFor(ref: MediaRef, mimeType: string): string {
  if (ref.fileName) return ref.fileName;
  const ext = EXTENSION_BY_MIME[mimeType.split(';')[0]?.trim() ?? ''];
  return ext ? `media-${ref.id}.${ext}` : `media-${ref.id}`;
}

/** Só os tipos com mídia para baixar; os demais (texto, localização, reação...) não têm `media`. */
function mediaRefOf(content: { type: string; media?: MediaRef }): MediaRef | null {
  return 'media' in content ? (content.media ?? null) : null;
}

/**
 * Processa um evento já gravado e deduplicado (`inbound_events`). Se a mensagem tem mídia, baixa da Graph API
 * ANTES de chamar o core — se o download falhar, a exceção propaga e o BullMQ tenta de novo mais tarde; a
 * mensagem só é gravada quando a mídia (se houver) já está em mãos, para nunca faltar depois.
 */
export async function processInboundJob(
  ctx: Ctx,
  graphEnv: GraphEnv,
  job: InboundJob,
): Promise<void> {
  const row = await loadInboundEvent(ctx, job.accountId, job.eventId);
  if (!row || row.status !== 'received') return; // já processado (job repetido) ou removido

  const target = await loadWhatsAppTarget(ctx, job.accountId, job.inboxId);
  if (!target) return; // a inbox foi removida ou trocou de canal nesse meio-tempo

  let media: { fileName: string; buffer: Buffer } | undefined;
  if (row.event.kind === 'message') {
    const ref = mediaRefOf(row.event.content);
    if (ref) {
      const graph: GraphConfig = {
        accessToken: target.config.accessToken,
        version: graphEnv.version,
        baseUrl: graphEnv.baseUrl,
        ...(graphEnv.fetch ? { fetch: graphEnv.fetch } : {}),
      };
      const fetched = await fetchMedia(graph, ref.id, MAX_ATTACHMENT_BYTES);
      media = { fileName: fileNameFor(ref, fetched.mimeType), buffer: fetched.data };
    }
  }

  await processWhatsAppEvent(ctx, target, row.event, media);
  await markInboundEventProcessed(ctx, job.accountId, job.eventId);
}

export function startWhatsAppInboundWorker(
  connection: ConnectionOptions,
  ctx: Ctx,
  graphEnv: GraphEnv,
  onError?: (err: unknown) => void,
) {
  return startInboundWorker(connection, (job) => processInboundJob(ctx, graphEnv, job), onError);
}
