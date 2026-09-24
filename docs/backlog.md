# Backlog

Itens fora do escopo da fase em que apareceram.

| Item                                                                                                                                           | Origem               | Fase alvo |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- |
| Passkeys / WebAuthn (`@simplewebauthn/server`)                                                                                                 | Seção 12.1, Fase 0   | 7         |
| Verificação de senhas vazadas (HIBP, k-anonymity)                                                                                              | Seção 12.1, opcional | 7         |
| SSO (OIDC/SAML)                                                                                                                                | Seção 12.1           | 7         |
| ~~Componentes de conversa~~ — MessageBubble, Composer, ConversationListItem e anexos prontos; falta `AudioWaveform` (mensagens de voz, Fase 2) | Seção 10A.8          | 2         |
| ~~Função `SECURITY DEFINER` para `api_keys`~~ — resolvido na Fase 1 com policy + GUC (`withApiKeyPrefix`)                                      | Passo 3, Fase 0      | feito     |
| ~~Sync por cursor com lacunas~~ — resolvido pelo cursor por conta sem lacunas (ADR 0006)                                                       | ADR-0003             | feito     |
| Convite de membro por e-mail (hoje o admin define a senha inicial)                                                                             | Fase 0, membros      | 7         |
| ~~Bearer/API key como autenticação~~ — feito no canal API (`POST /api/v1/messages`); falta ampliar os escopos                                  | Fase 0, API          | feito     |
| Reset de 2FA de um membro por Admin/Owner                                                                                                      | Fase 0, MFA          | 3         |
| Verificação automática de licenças das dependências (compatíveis com AGPL)                                                                     | ADR 0005             | 7         |
| Regressão visual (Playwright) da tela de Conversas completa (hoje cobre Storybook e widget)                                                    | Seção 10A.8          | 3         |
| Subir `minimumReleaseAge` do pnpm de 1 para 7 dias (hoje o lockfile tem versões recentes) e remover a exceção da regra no Semgrep              | CI, Fase 0           | 1         |

- Rate limit do canal API por chave (hoje é por IP, 600/min): integradores atrás do mesmo NAT dividem a cota.
- Widget: indicador de "atendente digitando", nome/foto do atendente nas respostas e som/notificação do navegador para resposta nova.
- Widget: incluir uma versão do segredo de identidade no token do visitante, para a rotação do segredo derrubar sessões já emitidas.
- Anexos: miniatura de imagens no painel e no widget; formatos do Office/ZIP com desarmamento de conteúdo (hoje ficam de fora); expurgo de anexos `awaiting_upload` órfãos (job periódico).
- Anexos: cota de armazenamento por conta e limite de tamanho configurável por conta.
- Painel: pré-visualização e arrastar-e-soltar de arquivos no compositor (o widget já aceita arrastar).
- Gateway WebSocket: com várias instâncias da API, presença e "quem está vendo" dependem do adaptador Redis (já ligado); testar com 2 instâncias.
- Cache da checagem de visibilidade de eventos por conta, se o custo por socket aparecer nas métricas (ADR 0007).
- Relay do outbox: métrica de latência entre `created_at` e `published_at` (hoje só há a contagem de publicados).
