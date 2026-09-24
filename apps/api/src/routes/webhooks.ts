import { acceptWhatsAppEvents, loadWhatsAppByPublicKey, type Ctx } from '@waychat/core';
import { parseWebhook, verifyChallenge, verifySignature } from '@waychat/channels-whatsapp';
import type { FastifyInstance } from 'fastify';
import { access } from '../types.js';

const MAX_WEBHOOK_BYTES = 512 * 1024;

/**
 * Webhooks dos canais externos. Rotas `public` (quem chama é a Meta, sem cookie), autenticadas pela ASSINATURA do
 * corpo. O corpo bruto é guardado antes do parse, porque o HMAC é calculado sobre os bytes originais.
 */
export function webhookRoutes(app: FastifyInstance, ctx: Ctx): void {
  void app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: MAX_WEBHOOK_BYTES },
      (req, body: Buffer, parsed) => {
        req.rawBody = body;
        try {
          parsed(null, body.length > 0 ? (JSON.parse(body.toString('utf8')) as unknown) : {});
        } catch {
          parsed(Object.assign(new Error('JSON inválido'), { statusCode: 400 }), undefined);
        }
      },
    );

    // Verificação do endpoint (a Meta chama uma vez ao cadastrar o webhook).
    scope.get<{ Params: { key: string }; Querystring: Record<string, string | undefined> }>(
      '/webhooks/whatsapp/:key',
      {
        config: {
          ...access.public,
          anyOrigin: true,
          rateLimit: { max: 60, timeWindow: '1 minute' },
        },
      },
      async (req, reply) => {
        const target = await loadWhatsAppByPublicKey(ctx, req.params.key);
        const challenge = target ? verifyChallenge(req.query, target.config.verifyToken) : null;
        // mesma resposta para "chave inexistente" e "token errado"
        if (challenge === null) return reply.code(403).send('forbidden');
        return reply.type('text/plain').send(challenge);
      },
    );

    scope.post<{ Params: { key: string } }>(
      '/webhooks/whatsapp/:key',
      {
        // A Meta envia de IPs compartilhados por muitos clientes: teto alto; o limite real é o da própria Meta.
        config: {
          ...access.public,
          anyOrigin: true,
          rateLimit: { max: 3000, timeWindow: '1 minute' },
        },
      },
      async (req, reply) => {
        const target = await loadWhatsAppByPublicKey(ctx, req.params.key);
        if (!target) return reply.code(404).send({ ok: false });
        const signature = req.headers['x-hub-signature-256'];
        if (
          !req.rawBody ||
          !verifySignature(
            req.rawBody,
            typeof signature === 'string' ? signature : undefined,
            target.config.appSecret,
          )
        ) {
          return reply.code(401).send({ ok: false });
        }
        // caixa desativada: aceita e descarta (recusar faria a Meta reenviar por horas)
        if (!target.enabled) return reply.send({ ok: true });
        let events;
        try {
          events = parseWebhook(req.body);
        } catch {
          return reply.code(400).send({ ok: false });
        }
        await acceptWhatsAppEvents(ctx, target, events);
        return reply.send({ ok: true });
      },
    );
    done();
  });
}
