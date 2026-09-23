# Backlog

Itens fora do escopo da fase em que apareceram.

| Item                                                                                                                                           | Origem               | Fase alvo |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------- |
| Passkeys / WebAuthn (`@simplewebauthn/server`)                                                                                                 | Seção 12.1, Fase 0   | 7         |
| Verificação de senhas vazadas (HIBP, k-anonymity)                                                                                              | Seção 12.1, opcional | 7         |
| SSO (OIDC/SAML)                                                                                                                                | Seção 12.1           | 7         |
| Componentes de conversa (MessageBubble, Composer, AudioWaveform, ConversationListItem)                                                         | Seção 10A.8          | 1         |
| Função `SECURITY DEFINER` para localizar `api_keys` por prefixo antes de haver tenant                                                          | Passo 3, Fase 0      | 1         |
| Sync por cursor: `cursor` do outbox pode confirmar fora de ordem; o relay lê pendentes por `SKIP LOCKED`, o `GET /sync` precisa tratar lacunas | ADR-0003             | 1         |
| Convite de membro por e-mail (hoje o admin define a senha inicial)                                                                             | Fase 0, membros      | 7         |
| Bearer/API key como forma de autenticação alternativa ao cookie                                                                                | Fase 0, API          | 1         |
| Reset de 2FA de um membro por Admin/Owner                                                                                                      | Fase 0, MFA          | 3         |
| Verificação automática de licenças das dependências (compatíveis com AGPL)                                                                     | ADR 0005             | 7         |
| Testes de regressão visual (Playwright) da tela de Conversas                                                                                   | Seção 10A.8          | 1         |
| Componentes de conversa: MessageBubble, Composer, AudioWaveform, ConversationListItem                                                          | Seção 10A.8          | 1         |
| Subir `minimumReleaseAge` do pnpm de 1 para 7 dias (hoje o lockfile tem versões recentes) e remover a exceção da regra no Semgrep              | CI, Fase 0           | 1         |
