# Plano — Fase 1 (Núcleo de atendimento)

Status: **em execução** — passos 1 (banco), 2 (contatos, inboxes, chaves de API) e 3 (conversas e mensagens) concluídos; o passo 9 (painel) foi adiantado, com atualização por consulta periódica até o WebSocket (passo 5). (O responsável delegou as decisões em aberto: "faça como achar melhor"; elas estão registradas abaixo.)

## Escopo (seção 16 do prompt)

Inboxes (canal API e widget web), contatos, conversas, mensagens, anexos, notas internas, labels, respostas prontas, WebSocket com sync por cursor, painel do atendente, widget.

**Aceite:**

1. A tela de Conversas reproduz layout, cores e componentes da seção 10A nos temas claro e escuro (regressão visual aprovada).
2. Mensagem enviada pelo widget aparece no painel em < 500 ms (p95, medido em teste).
3. A reconexão recupera eventos perdidos.
4. Reenvio com o mesmo `client_message_id` não duplica.

## Decisões de arquitetura

### D1 — Cursor de eventos sem lacunas, por conta (ADR 0006)

O `cursor` do outbox da Fase 0 é uma coluna identity global: transações concorrentes podem confirmar fora de ordem, e um cliente que sincroniza com `since=N` pularia um evento `N-1` confirmado depois. Para o `GET /sync` ser correto, o cursor passa a ser **por conta e sem lacunas**: um trigger `BEFORE INSERT` em `outbox` faz `INSERT ... ON CONFLICT DO UPDATE SET event_seq = event_seq + 1 RETURNING` em `account_counters`, na própria transação (vale para qualquer inserção, não só a de `enqueueEvent`). O UPSERT trava a linha do contador até o COMMIT, então a ordem de commit de uma conta é a ordem do cursor. O custo é serializar as escritas que geram evento _dentro da mesma conta_ (aceitável para dezenas de atendentes; contas diferentes não se bloqueiam). O envelope passa a carregar `cursor = account_seq`. A coluna identity antiga (`cursor`) fica só para o relay varrer pendentes; o cursor público é `account_seq`. O `display_id` das conversas usa o mesmo mecanismo.

### D2 — Ordenação por conversa

O processamento de entrada de uma conversa toma `pg_advisory_xact_lock(hashtext(conversation_id))` dentro da transação; mensagens da mesma conversa são inseridas em série. A exibição ordena por `(created_at, id)`.

### D3 — Idempotência

- Entrada por canal: `inbound_events` único `(inbox_id, external_id)` (a segunda entrega vira 200 sem efeito).
- Saída pelo painel/widget: `messages.client_message_id` único por conta; reenviar devolve a mesma mensagem.

### D4 — Tempo real

Socket.IO no processo da API, adaptador Redis (Valkey) para fan-out entre instâncias. Autenticação pelo mesmo cookie de sessão (painel) ou por token HMAC do widget. Salas `account:{id}`, `inbox:{id}`, `conversation:{id}`, `user:{id}`; a entrada em cada sala passa por checagem de permissão (deny-by-default, com teste). O gateway assina `wc:events:{account_id}` (já publicado pelo relay na Fase 0) e reenvia só ao que o usuário pode ver. Ao reconectar, o cliente chama `GET /sync?since={cursor}`.

### D5 — Visibilidade

Um atendente vê conversas das **inboxes de que é membro** (`inbox_members`); Owner/Admin/Supervisor com `conversations:read_all` veem todas. A regra vale em REST, WebSocket e `/sync`, e é testada nos três.

### D6 — Autenticação do canal API

Chaves de API (`Authorization: Bearer wc_<prefixo>_<segredo>`), escopos e expiração. A busca por prefixo antes de existir tenant usa uma policy de leitura ligada a uma GUC (`app.api_key_prefix`, helper `withApiKeyPrefix`), o mesmo padrão de `member_self_read`: sem `SECURITY DEFINER` (que não funcionaria com RLS forçada e dono não-superusuário). O mesmo vale para localizar a inbox pela chave pública (`withInboxPublicKey`).

### D7 — Widget

Preact + Vite, Shadow DOM, meta < 50 KB gzip (verificada em CI). Identidade do visitante verificada por HMAC: o site do cliente assina `identifier` com o segredo da inbox; sem assinatura o visitante é anônimo. Sessão do visitante por token opaco de conversa (cookie próprio, `SameSite=Lax`, escopado à inbox).

### D8 — Uploads

Validação por magic bytes (não pela extensão), limite de tamanho por tipo, nome UUID, S3/MinIO com URL assinada de curta duração (download e upload direto), `Content-Disposition` correto. **ClamAV** (`clamd` no compose): o anexo nasce `pending_scan` e só é servido após `clean`; infectado é apagado e auditado. A varredura é um job do worker.

### D9 — Frontend

`apps/web`: React + Vite + TanStack Router/Query + Zustand + Tailwind v4, tokens do `@waychat/ui`, PWA. Lista de conversas virtualizada. UI otimista para envio, com `client_message_id`. Regressão visual: Playwright compara a tela de Conversas com as imagens de referência (captura própria, tolerância definida em ADR quando o baseline existir).

## Modelo de dados (migração `0005+`)

Todas com `account_id`, RLS forçada e a policy padrão; incluídas no teste de catálogo.

| Tabela                                              | Notas                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account_counters`                                  | `account_id` PK, `event_seq` (cursor de eventos) e `conversation_seq` (`display_id`), ambos sem lacunas                                                                                                        |
| `inboxes`, `inbox_members`                          | tipo `api` \| `widget`; `config` **cifrado** (AES-GCM, AAD `inbox:<id>`); `public_key` da inbox; horário de atendimento fica para a Fase 3                                                                     |
| `contacts`, `contact_identities`                    | identidade única `(account_id, channel, external_id)`; atributos em `jsonb`; mesclar contatos fica para a Fase 5                                                                                               |
| `conversations`                                     | `display_id` sequencial por conta, `status` (`open \| pending \| snoozed \| resolved`), prioridade, `assignee_id`, `last_customer_message_at`, `last_activity_at`; índice do prompt                            |
| `messages`                                          | direção, tipo, `content`, `content_attributes jsonb`, `private` (nota interna), `reply_to_id`, `source_id` único por inbox, `client_message_id` único, status; índice `(conversation_id, created_at DESC, id)` |
| `attachments`                                       | `storage_key`, `content_type` detectado, `size`, `scan_status`                                                                                                                                                 |
| `labels`, `conversation_labels`, `canned_responses` | atalho `/` único por conta                                                                                                                                                                                     |
| Policies de leitura por chave pública               | `inbox_public_key_read` e `api_key_prefix_read` (ver D6)                                                                                                                                                       |

Mensagens são `content` texto; conteúdo de mensagem **nunca** vai para log nem para métricas (redaction já cobre `content`).

## Ordem de execução (cada passo termina com testes verdes e commit)

1. **Banco:** `account_counters` + cursor por conta (ADR 0006), tabelas acima, RLS, policies de leitura por chave, testes de isolamento e de gap-free sob concorrência.
2. **Contatos e inboxes** (core + API): CRUD com permissões novas (`inboxes:manage`, `contacts:*`), chaves de API, config cifrada.
3. **Conversas e mensagens** (core): abrir/encontrar conversa, inserir mensagem sob lock, idempotência, status, atribuição, notas internas, labels, respostas prontas; tudo emite eventos pelo outbox.
4. **Visibilidade e `GET /sync`**: filtro por inbox em REST e sync, paginação por cursor, testes de vazamento entre atendentes.
5. **WebSocket** (Socket.IO + adaptador Redis): auth, salas com checagem, eventos tipados de `packages/shared/events.ts`, `typing`/`presence` mínimos, teste de reconexão com recuperação por cursor.
6. **Canal API:** `POST /api/v1/messages` (idempotente por `external_id`) e webhook de saída assinado (HMAC + timestamp) — a assinatura de saída fica para a Fase 3; aqui só a entrada.
7. **Anexos:** upload direto com URL assinada, magic bytes, ClamAV no compose, job de varredura.
8. **Widget** (`apps/widget`): Preact, Shadow DOM, pré-chat, anexos, HMAC de identidade, i18n pt-BR/en/es, orçamento de 50 KB.
9. **Painel** (`apps/web`): login (com 2FA), tela de Conversas conforme a 10A (barra superior, sidebar, lista virtualizada, área da conversa com cabeçalho de vidro, compositor, painel lateral), componentes de conversa em `packages/ui` (`MessageBubble`, `Composer`, `AudioWaveform`, `ConversationListItem`) com Storybook.
10. **Aceite:** teste de latência widget → painel (< 500 ms p95), reconexão, `client_message_id`, regressão visual (Playwright) nos dois temas.
11. **Docs:** ADR 0006 (cursor) e 0007 (visibilidade + WebSocket), OpenAPI, CHANGELOG, atualização do `backlog.md`.

## Riscos

| Risco                                                                | Mitigação                                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor por conta serializa escritas com evento na mesma conta        | Medido em teste de carga; a região crítica é só o UPDATE do contador, que fica no fim da transação                                                |
| Widget estourar 50 KB                                                | Preact, sem dependências de UI, orçamento verificado em CI                                                                                        |
| Regressão visual frágil (fonte, antialiasing)                        | Baseline gerada no mesmo container do CI (Playwright oficial); tolerância pequena e explícita                                                     |
| As imagens de referência são recortes inclinados, não telas frontais | Reproduzir os tokens, proporções e componentes descritos na 10A; a comparação é por regiões (lista, área, painel), não pixel a pixel com a imagem |
| ClamAV pesado no CI                                                  | Testes de varredura usam o `clamd` do compose só na suíte de integração; unitários usam um scanner fake                                           |

## Fora de escopo (vai para `docs/backlog.md`)

WhatsApp e demais canais (Fase 2); regras de automação, atribuição automática, SLA, horário comercial, notificações e menções `@` em notas (Fase 3); fluxos (Fase 4); campanhas, mesclagem de contatos, importação CSV, Pipeline, Bloqueados e Lixeira (Fase 5); IA (Fase 6); relatórios (Fase 7); envio de e-mail.
