import { enqueueSend, startSendWorker, type SendJob } from '@waychat/channels';
import { classifyError, send, type GraphConfig } from '@waychat/channels-whatsapp';
import {
  claimWhatsAppSend,
  loadWhatsAppTarget,
  outboundContentFor,
  recordWhatsAppFailed,
  recordWhatsAppSent,
  SendPendingError,
  type Ctx,
} from '@waychat/core';
import type { EventEnvelope } from '@waychat/shared';
import type { ConnectionOptions, Job, Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { GraphEnv } from './whatsapp-inbound.js';
import { acquireSendSlot } from './whatsapp-rate-limit.js';

/**
 * Tempo que o job espera o webhook de status confirmar um envio ambíguo antes de tentar de novo (ADR 0011).
 * Passado esse tempo desde que o job foi criado, `claimWhatsAppSend` decide reenviar.
 */
const WAIT_WINDOW_MS = 120_000;

/**
 * Processa um job de envio. `claimWhatsAppSend` decide sozinho o que fazer com o estado atual da mensagem
 * (enviar, esperar ou já concluir); aqui só chama o adaptador e grava o resultado.
 */
export async function processSendJob(
  ctx: Ctx,
  redis: Redis,
  graphEnv: GraphEnv,
  job: Job<SendJob>,
): Promise<void> {
  const target = await loadWhatsAppTarget(ctx, job.data.accountId, job.data.inboxId);
  if (!target) return; // a inbox foi removida ou trocou de canal nesse meio-tempo

  const pastWaitWindow = Date.now() - job.timestamp >= WAIT_WINDOW_MS;
  const claim = await claimWhatsAppSend(ctx, job.data.accountId, job.data.messageId, {
    pastWaitWindow,
  });
  if (!claim) return; // já resolvido (inclusive o caso "anexo demais", que já sai marcado "failed")

  await acquireSendSlot(redis, job.data.inboxId, target.config.rateLimitPerSecond);

  let content;
  try {
    content = await outboundContentFor(ctx, claim);
  } catch (e) {
    // problema do NOSSO lado (anexo ainda não terminou de escanear, por exemplo): não adianta chamar a Meta.
    await recordWhatsAppFailed(
      ctx,
      job.data.accountId,
      job.data.messageId,
      'attachment_error',
      e instanceof Error ? e.message : 'Falha ao preparar o anexo para envio.',
    );
    return;
  }

  const graph: GraphConfig = {
    accessToken: target.config.accessToken,
    version: graphEnv.version,
    baseUrl: graphEnv.baseUrl,
    ...(graphEnv.fetch ? { fetch: graphEnv.fetch } : {}),
  };
  try {
    const result = await send(
      {
        to: claim.to,
        content,
        opaque: job.data.messageId,
        ...(claim.replyToProviderId ? { replyToProviderId: claim.replyToProviderId } : {}),
      },
      graph,
    );
    await recordWhatsAppSent(ctx, job.data.accountId, job.data.messageId, result.providerMessageId);
  } catch (err) {
    const classified = classifyError(err);
    if (!classified.retryable) {
      await recordWhatsAppFailed(
        ctx,
        job.data.accountId,
        job.data.messageId,
        classified.code,
        classified.userMessage,
      );
      return;
    }
    // ambíguo (rede/timeout) ou transitório (5xx/limite de taxa): deixa o job falhar. Na próxima tentativa,
    // `claimWhatsAppSend` decide esperar o webhook ou reenviar — nunca reenviamos daqui direto.
    throw err;
  }
}

/**
 * Handler do evento `message.created` do outbox: mensagem de saída, não privada, cuja inbox é WhatsApp (nascida
 * `queued` por `sendMessage`) ganha um job de envio. Widget e canal API nascem `sent` e nunca chegam aqui — mas
 * a checagem da inbox é o que evita enfileirar à toa para eles, sem precisar reconferir o status da mensagem.
 */
export function handleMessageCreated(ctx: Ctx, sendQueue: Queue<SendJob>) {
  return async (event: EventEnvelope): Promise<void> => {
    if (event.payload['direction'] !== 'out' || event.payload['private'] === true) return;
    const messageId = event.payload['message_id'];
    const inboxId = event.payload['inbox_id'];
    if (typeof messageId !== 'string' || typeof inboxId !== 'string') return;
    const target = await loadWhatsAppTarget(ctx, event.account_id, inboxId);
    if (!target) return; // não é uma inbox de WhatsApp
    await enqueueSend(sendQueue, { accountId: event.account_id, inboxId, messageId });
  };
}

export function startWhatsAppSendWorker(
  connection: ConnectionOptions,
  ctx: Ctx,
  redis: Redis,
  graphEnv: GraphEnv,
  onError?: (err: unknown) => void,
) {
  return startSendWorker(
    connection,
    (job) => processSendJob(ctx, redis, graphEnv, job),
    (err) => {
      if (!(err instanceof SendPendingError)) onError?.(err);
      // SendPendingError é esperado (a mensagem está esperando o webhook confirmar): não é uma falha real.
    },
  );
}
