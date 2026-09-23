# 0003 — Transactional Outbox

- Status: aceito
- Fase: 0

## Contexto

Mudar o estado no banco e publicar um evento (WebSocket, automações, webhooks) são duas escritas em sistemas diferentes. Se o processo cair entre elas, o evento se perde ou o estado fica sem evento.

## Decisão

Toda mudança que gera evento grava uma linha em `outbox` **na mesma transação** (`enqueueEvent`). O worker roda um relay:

1. numa transação, seleciona pendentes por `cursor` com `FOR UPDATE SKIP LOCKED` (vários relays em paralelo nunca pegam o mesmo evento);
2. publica o lote — um job BullMQ por evento com `jobId = event_id` e um `PUBLISH` por evento em `wc:events:{account_id}`;
3. marca `published_at` e dá COMMIT.

Se a publicação falhar, há ROLLBACK e o próximo ciclo reenvia: **at-least-once**. A duplicata é inofensiva porque o `jobId` faz o BullMQ ignorar o segundo job e o cliente deduplica o pub/sub por `event_id`.

O relay usa a role `waychat_relay`: `SELECT` e `UPDATE (published_at)` só em `outbox`, com policy própria (`TO waychat_relay USING (true)`). Assim lê todos os tenants sem `BYPASSRLS` e sem poder alterar o conteúdo do evento.

Falhas de handler seguem o backoff exponencial com jitter do BullMQ (8 tentativas) e, esgotadas, vão para a fila `domain-events-dlq` com o motivo. O contexto de trace (`traceparent`) é gravado com o evento, então o trace HTTP → outbox → fila → worker é um só.

## Consequências

- Nenhum evento se perde por queda entre "gravei" e "publiquei" (coberto por teste que derruba a publicação no meio).
- A ordem é por `cursor`, mas a coluna identity pode confirmar fora de ordem; por isso o relay lê por pendência, e o `GET /sync?since={cursor}` da Fase 1 precisa tratar lacunas.
- Handlers precisam ser idempotentes.
