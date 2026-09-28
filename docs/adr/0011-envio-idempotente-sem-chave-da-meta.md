# ADR 0011 — Envio ao WhatsApp idempotente sem chave de idempotência da Meta

Status: aceito (Fase 2)

## Contexto

Enviar uma mensagem pela Cloud API é uma chamada HTTP comum: `POST /{phone_number_id}/messages`. A Meta **não
oferece uma chave de idempotência** nesse endpoint — ao contrário de provedores de pagamento, por exemplo, não dá
para mandar um "id de requisição" e ter a garantia de que reenviar com o mesmo id não duplica. Se o processo cai
exatamente entre enviar a requisição e gravar a resposta, não há como saber com certeza se a mensagem chegou ao
cliente ou não, só reenviando (o que arrisca duplicar) ou perguntando à Meta de outra forma.

## Decisão

1. **`biz_opaque_callback_data` carrega o nosso id.** Toda chamada de envio leva `opaque = messages.id` nesse campo.
   A Meta devolve esse valor inalterado em TODOS os webhooks de status daquela mensagem. É o mais perto que a API
   oferece de uma chave de correlação — não impede duplicar o envio, mas permite reconciliar depois.
2. **Máquina de estados da mensagem:** `queued → sending → sent → delivered → read` (mais `failed`, que vale a
   qualquer momento antes de `delivered`). Nascer `queued` é exclusivo de canais com entrega assíncrona (hoje só
   WhatsApp); os demais continuam nascendo `sent`, sem essa cadeia.
3. **Reivindicação atômica (`claimWhatsAppSend`).** Uma transação com lock por mensagem decide o que fazer:
   - resolvida (`sent`/`delivered`/`read`/`failed`) → nada a fazer;
   - `sending` com `source_id` (wamid) já gravado → o envio funcionou e só a marcação final não terminou; conclui
     para `sent` agora, sem chamar a Meta de novo;
   - `sending` **sem** `source_id` e ainda **dentro de uma janela de 2 minutos** desde que o job de envio começou
     → estado ambíguo: a chamada pode ter ido, pode não ter ido. Em vez de reenviar às cegas, o job **lança e
     falha de propósito**, para o BullMQ tentar de novo mais tarde. Enquanto isso, se a chamada original tiver
     ido, o webhook de status chega e resolve pela via 2 acima;
   - `queued`, ou `sending` sem `source_id` **fora** da janela de 2 minutos → marca `sending` (soma uma
     tentativa) e segue para a chamada de verdade.
4. **Erro definitivo não espera.** Se a Graph API responde com um erro que não é de rede/timeout (`classifyError`
   diz `retryable: false` — ex.: janela de atendimento fechada, número inválido, token expirado), a mensagem vai
   direto para `failed`: não faz sentido esperar um webhook que nunca vai confirmar um envio que a Meta já
   recusou. Só erros ambíguos (falha de rede, timeout, 5xx, limite de taxa) deixam a exceção subir para a
   reconciliação do item 3.
5. **A fila de envio é separada da fila de eventos genérica.** O evento `message.created` do outbox só decide
   **se** precisa enfileirar um envio (mensagem de saída, não privada, de uma inbox WhatsApp) e delega para a fila
   `channel-send`, com `jobId = messages.id` — o mesmo id nunca vira dois jobs, e o job de envio tem seu próprio
   backoff, independente de outros tipos de evento.
6. **Limite de taxa por número (D9)** é aplicado ANTES de chamar a Graph API, com uma janela de 1 segundo em
   Valkey por inbox — evita estourar o limite da própria conta e atropelar o backoff de erros de limite de taxa
   que a Meta devolveria de qualquer forma.

## Consequências

- **Risco residual aceito:** se a chamada original teve sucesso mas a resposta se perdeu por completo (não só um
  timeout, mas também nunca chegando o webhook de status dentro da janela — o que só aconteceria se o PRÓPRIO
  webhook também falhasse), o reenvio depois da janela de 2 minutos pode duplicar a mensagem do lado do cliente.
  Não há como eliminar esse risco sem uma chave de idempotência do provedor; ele é mitigado pela janela (2 minutos
  é tempo de sobra para um webhook de status chegar em operação normal) e é o motivo de a janela existir, em vez
  de reenviar imediatamente.
- Mídia de saída usa um link assinado de curta duração (mesmo mecanismo de download do painel), não a biblioteca
  de mídia da Meta — mais simples, com o custo de depender do nosso S3 estar acessível no momento em que a Meta
  busca o link (ver `packages/core/src/modules/channels/application/outbound.ts`).
- O WhatsApp só aceita um anexo por mensagem; mais de um é um erro definitivo (`failed` imediato, sem nem chamar a
  Graph API), não uma tentativa que fica repetindo.
