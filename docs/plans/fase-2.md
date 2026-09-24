# Plano — Fase 2 (WhatsApp Cloud API)

Status: **em execução** — passos 1 (pacote de canais, fixtures e contrato) e 2 (banco) concluídos. Base: branch `fase-1` (PR #11). Decisões abaixo foram tomadas por padrão, seguindo "faça como achar melhor"; as que dependem de você estão em "Perguntas em aberto".

## Escopo (seção 8 do prompt)

Adaptador completo da **WhatsApp Business Platform — Cloud API oficial**: conexão manual da inbox, webhook assinado, todos os tipos de mensagem (entrada e saída), mídia no S3, status, janela de 24 h, templates sincronizados, erros traduzidos, limitador de taxa, opt-out, qualidade do número, marcar como lida e digitação.

**Aceite (seção 16):**

1. Testes de contrato para todos os tipos de payload (fixtures reais em `packages/channels/whatsapp-cloud/__fixtures__`).
2. Webhook duplicado não gera mensagem duplicada.
3. Com a janela fechada o painel exige template (compositor bloqueia texto livre e mostra o contador).
4. Derrubar o worker durante o envio não perde nem duplica mensagem.

**Fora de escopo (vai para `docs/backlog.md`):** Embedded Signup e WhatsApp Flows ("fase posterior" no prompt); Coexistence (avaliar quando a Meta estabilizar a documentação); campanhas e respeito ao tier (Fase 5, mas o limitador por número e o opt-out ficam prontos aqui); biblioteca não oficial (WhatsApp Web) — recusada, registrar em ADR.

## Decisões de arquitetura

**D1. Pacote de canais.** `packages/channels/core` (`@waychat/channels`) define `ChannelAdapter` exatamente como na seção 8.4 e os tipos normalizados (`NormalizedEvent`, `OutboundMessage`, `ChannelCapabilities`); `packages/channels/whatsapp-cloud` (`@waychat/channels-whatsapp`) implementa. O núcleo não conhece a Meta: só o adaptador. O workspace passa a incluir `packages/channels/*`. O canal `api` e o `widget` continuam como estão (não viram adaptadores agora).

**D2. Conexão manual.** Inbox `channel_type = 'whatsapp'` (a constraint do banco é ampliada). Config cifrada (AES-256-GCM, AAD `inbox:<id>`) com Phone Number ID, WABA ID, token do System User, App Secret e verify token (gerado no servidor). A API e a tela só devolvem os **últimos 4 caracteres** dos segredos. Versão da Graph API em `WHATSAPP_GRAPH_VERSION` (padrão `v23.0`, configurável).

**D3. Webhook.** `GET/POST /webhooks/whatsapp/:inbox_public_key` (rota `public`, `anyOrigin`). GET responde ao `hub.challenge` se o verify token bate (comparação em tempo constante). POST exige `X-Hub-Signature-256` = HMAC-SHA256 do **corpo bruto** com o App Secret; assinatura ruim → 401 sem processar. O handler só valida, grava em `inbound_events` (único por `inbox_id + external_id`: é a barreira contra webhook duplicado), enfileira o processamento e responde 200 em milissegundos (a Meta reenvia se demorar). O processamento é assíncrono no worker.

**D4. Idempotência de entrada.** `external_id` = `wamid` (mensagens) ou `wamid:status` (status). Reentrega da Meta cai na unicidade e vira no-op; o `source_id` da mensagem (`wamid`) tem unicidade por inbox, como já existe. Status fora de ordem (ex.: `read` antes de `delivered`) nunca regridem o estado (só avançam: `queued < sent < delivered < read`; `failed` vale a qualquer momento antes de `delivered`).

**D5. Mídia de entrada.** Job que baixa pelo media ID **imediatamente** (URL expira em minutos), valida tipo (mesma lista fechada + ogg/opus, webp de sticker, etc.) e tamanho (limites da Meta por tipo), grava no S3 e cria `attachments` com `uploader_type = 'contact'`, passando pela mesma varredura ClamAV da Fase 1. Enquanto não estiver `clean` a mensagem aparece com "Baixando/verificando anexo…". Falha definitiva vira mensagem com anexo `rejected` e motivo, nunca some em silêncio.

**D6. Envio (fila + idempotência).** Mensagem de saída numa inbox WhatsApp nasce `queued`; o evento `message.created` (outbox) dispara o job `channel-send` (BullMQ, `jobId = message_id`). O worker: (1) marca `sending` com um contador de tentativas; (2) chama a Graph API enviando o **id da nossa mensagem em `biz_opaque_callback_data`**; (3) grava o `wamid` e passa a `sent`. A Meta não tem chave de idempotência; por isso, se o processo cai entre (2) e (3), a recuperação **não reenvia às cegas**: o job retomado vê `sending` sem `wamid`, espera até 2 min o webhook de status que devolve o nosso id (isso confirma o envio e recupera o `wamid`) e só reenvia se nada chegar. Risco residual (envio real sem webhook no prazo) registrado no ADR 0010 e coberto por teste de queda simulada.

**D7. Janela de 24 h.** Calculada no core a partir de `conversations.last_customer_message_at`. `GET /conversations/:id` passa a devolver `window: { open, expiresAt }` (só para canais com janela, via `capabilities()`). `sendMessage` com janela fechada e sem template → erro `window_closed` (422); a checagem é no servidor, a UI só reflete.

**D8. Templates.** Tabela `message_templates` por inbox (nome, idioma, categoria, status, componentes em JSON, id da Meta). Job de sincronização lista da Graph API (paginado) e o webhook `message_template_status_update` atualiza status; criação pelo painel (`POST`) com acompanhamento de aprovação. Envio de template com variáveis preenchidas com dados do contato, cabeçalho de mídia e botões. Pré-visualização fiel no painel.

**D9. Erros, limite de taxa e qualidade.** `classifyError` mapeia os códigos da documentação (ex.: 131047 janela expirada, 131026 número não recebe, 131030 fora da lista, 130429/131056 limite de taxa, 190/10 token, 100 parâmetro inválido…) para `{ retryable, code, userMessage }` em português; `failed` grava o código e a mensagem legível na mensagem. Limitador **por número** (token bucket em Valkey, padrão 80 msg/s, configurável por inbox) e backoff exponencial com jitter em throttling. Quality rating e tier vêm de `phone_number_quality_update` e de consulta periódica; queda de qualidade gera evento `inbox.quality_changed` e alerta no painel para admins.

**D10. Opt-out e recibos.** Palavras-chave configuráveis por inbox (padrão `SAIR`, `PARAR`) registram `contact_opt_outs` (canal + contato, com o texto e a data) e respondem com a confirmação configurável; campanhas (Fase 5) vão consultar essa tabela. Marcar como lida e indicador de digitação acontecem quando o atendente abre/responde a conversa, ligáveis por inbox.

**D11. Testes sem a Meta.** Um servidor Graph API falso (`packages/channels/whatsapp-cloud/src/testing/fake-graph.ts`) simula envio, mídia, templates, throttling e falhas, para os testes de contrato e de queda do worker. A conexão real com um número de teste fica como roteiro manual (`docs/runbooks/whatsapp-conexao.md`).

## Modelo de dados (migração `0013+`)

- `inboxes.channel_type` aceita `whatsapp`; colunas `quality_rating`, `messaging_tier`, `quality_checked_at`.
- `messages`: `status` ganha `sending`; `error_code` e `attempts` (o `wamid` fica em `source_id`, já único por inbox; a mensagem legível em `error`); tipos de conteúdo (`type`: text, image, audio, voice, video, document, sticker, location, contacts, reaction, interactive, button_reply, list_reply, template) com dados estruturados em `content_attributes`; `reply_to_id` já existe (citação).
- `message_templates`, `contact_opt_outs`, `attachments.uploader_type` aceita `contact`.
- Tudo com RLS forçada e testes de isolamento entre contas, como nas fases anteriores.

## Ordem de execução (cada passo termina com testes verdes e commit)

1. **Pacote de canais:** interface `ChannelAdapter`, tipos normalizados, fixtures reais de webhook (todos os tipos de mensagem e status) e `parseWebhook` com testes de contrato.
2. **Banco:** migração da lista acima, RLS e testes.
3. **Conexão da inbox:** criação/edição da inbox WhatsApp (config cifrada, segredos mascarados), verificação do webhook, rotação de token.
4. **Ingresso do webhook:** assinatura, corpo bruto, `inbound_events`, deduplicação e enfileiramento; teste de webhook duplicado.
5. **Processamento de entrada:** todos os tipos de mensagem, respostas citadas, reações, status, mídia no S3 com varredura, opt-out.
6. **Envio:** fila, `sending`, `biz_opaque_callback_data`, limitador por número, erros traduzidos, status; teste de queda do worker.
7. **Janela e templates:** cálculo da janela, `window_closed`, sincronização, criação e envio de templates.
8. **Painel:** tela "Canais" (conectar WhatsApp), bolhas para todos os tipos (imagem, vídeo, documento, sticker, localização, contatos, reação, interativa) com player de áudio/voz (`AudioWaveform`), contador da janela e seletor de template no compositor.
9. **Qualidade, recibos e digitação:** rating/tier com alerta, marcar como lida, indicador de digitação.
10. **Aceite e docs:** os quatro critérios como testes, ADRs 0010 (envio idempotente sem chave da Meta), 0011 (webhook e deduplicação) e 0012 (recusa de bibliotecas não oficiais), runbook de conexão real, OpenAPI, CHANGELOG e backlog.

## Riscos

| Risco                                                   | Mitigação                                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Meta não oferece idempotência de envio                  | `biz_opaque_callback_data` + espera do status antes de reenviar (D6); risco residual documentado e testado |
| Payloads reais diferem das fixtures                     | Fixtures copiadas da documentação oficial; roteiro manual com número de teste para validar antes do merge  |
| Mídia expira antes do download (fila cheia)             | Fila própria de mídia com prioridade alta e tentativas rápidas; falha definitiva visível na mensagem       |
| Webhook lento causa reentregas em cascata               | Handler só valida, grava e enfileira (D3); processamento fora da requisição                                |
| Vazamento de segredo do canal em log/erro               | Redaction já cobre `token`/`secret`; testes de que respostas e logs nunca trazem o valor completo          |
| Ordem de status invertida (`read` antes de `delivered`) | Máquina de estados que só avança (D4), testada com permutações                                             |

## Perguntas em aberto

1. **Número/conta de teste da Meta:** você já tem um app na Meta com número de teste (Phone Number ID, WABA ID, token, App Secret)? Sem ele, todo o desenvolvimento e o aceite rodam contra o servidor Graph falso; a validação real fica para quando você fornecer os dados (nunca no repositório: `.env` local).
2. **Domínio público para o webhook:** a Meta precisa alcançar `https://<dominio>/webhooks/whatsapp/...`. Para testar localmente vou usar um túnel; qual você prefere (Cloudflare Tunnel, ngrok, outro)? Padrão: documentar Cloudflare Tunnel.
3. **Resposta automática de opt-out:** confirmar ao cliente ("Você não receberá mais mensagens") por padrão, ou só registrar? Padrão adotado: confirmar, com texto configurável.
