# ADR 0010 — Webhook do WhatsApp: assinatura, deduplicação e processamento assíncrono

Status: aceito (Fase 2)

## Contexto

O webhook da Meta é a única porta de entrada do canal WhatsApp: toda mensagem, status de entrega, atualização de
template e de qualidade do número chega por ele. Três problemas específicos desse tipo de integração:

1. **Autenticidade.** Qualquer um que descubra a URL pode tentar mandar payloads forjados.
2. **Reentrega.** A Meta reenvia um webhook se não receber `200` a tempo — o mesmo evento pode chegar várias vezes.
3. **Latência do handler.** Processar tudo dentro da requisição (contato, conversa, mensagem, baixar mídia) arrisca
   estourar o tempo que a Meta espera pelo `200`, o que causaria mais reentregas.

## Decisão

1. **Assinatura sobre o corpo bruto.** `X-Hub-Signature-256` é HMAC-SHA256 do **corpo bruto** (bytes exatos, antes de
   qualquer parse) com o App Secret da inbox. O parser de JSON do Fastify é substituído por um que guarda o buffer
   original antes de decodificar; a assinatura é conferida ANTES do corpo ser interpretado. Assinatura ausente, errada
   ou de um corpo alterado depois de assinado: `401`, nada é gravado. A verificação usa `timingSafeEqual`.
2. **Verificação do endpoint (`GET`)** ecoa `hub.challenge` só se `hub.verify_token` bater com o gerado para aquela
   inbox (comparação em tempo constante). Chave pública desconhecida e token errado respondem a mesma coisa (`403`),
   para não revelar se a chave existe.
3. **Deduplicação por chave única no banco.** Cada evento normalizado vira uma linha de `inbound_events`, única por
   `(inbox_id, external_id)`. A chave depende do tipo de evento: mensagem e status usam o id da Meta (`wamid`,
   compondo com o status no caso de status, já que o mesmo `wamid` tem vários status ao longo do tempo); atualização
   de template usa o id do template + o novo status; qualidade (que não tem id nem horário) usa uma chave por dia. A
   unicidade do Postgres é a barreira real contra webhook duplicado — não uma checagem em memória, que não sobrevive
   a duas instâncias da API recebendo o mesmo reenvio ao mesmo tempo.
4. **O handler HTTP só valida, grava e enfileira.** Depois de gravar as linhas novas, cada uma vira um job na fila
   `channel-inbound` (BullMQ, `jobId` fixo por evento: enfileirar de novo nunca cria um segundo job) e a resposta
   `200` sai em milissegundos. Quem interpreta o conteúdo (contato, conversa, mensagem, baixar mídia, aplicar status)
   é o worker, fora da requisição.
5. **Caixa desativada aceita e descarta.** Se a inbox foi desligada depois de a Meta já ter o webhook configurado,
   recusar faria a Meta reenviar por horas; a resposta é sempre `200`, só que nada é gravado.
6. **Núcleo sem HTTP.** `packages/core` não fala com a Graph API: `acceptWhatsAppEvents` só grava e enfileira; quem
   baixa mídia é o worker, ANTES de chamar o processamento (`processWhatsAppEvent`), passando os bytes já prontos.
   Isso mantém o core livre do SDK da Meta e o download fora de qualquer transação do banco.
7. **Status nunca regride.** Webhooks de status podem chegar fora de ordem (rede, filas do lado da Meta). A aplicação
   de um novo status só avança na ordem `queued → sending → sent → delivered → read`; `failed` vale a qualquer
   momento antes de `delivered`, mas depois de `delivered`/`read`/`failed` nenhum status seguinte é aceito.

## Consequências

- Falha no processamento (worker, DB, Graph API) faz o job da fila repetir com backoff; a linha em `inbound_events`
  continua `received` até um processamento completo, então uma queda no meio nunca perde o evento — só atrasa.
- Não há fila de mensagens mortas própria para `channel-inbound` ainda: um evento que esgota as tentativas fica
  `received` para sempre, sem alerta (registrado no backlog).
- A mídia é buscada com o `mime_type` que a própria Meta informou; um tipo fora da lista de anexos aceita (imagem,
  áudio, vídeo, documento, texto — a mesma lista fechada da Fase 1) é descartado, mas a mensagem em si é sempre
  gravada — nunca desaparece em silêncio.
