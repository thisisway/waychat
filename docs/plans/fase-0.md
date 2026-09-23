# Plano — Fase 0 (Fundação)

Status: **implementada** — passos 1–12 concluídos; falta apenas a confirmação do CI no GitHub (o repositório ainda não recebeu o push).

## Escopo (seção 16 do prompt)

Monorepo, CI, Docker Compose, design system (tokens, fonte, componentes base, Storybook), schema base, RLS, autenticação (senha + TOTP + sessões), contas/usuários/papéis, auditoria, logger, OpenTelemetry, estrutura de filas e outbox.

**Aceite:** CI verde; teste prova que um tenant não lê dados de outro; login com 2FA funcionando; rota sem declaração de permissão quebra o teste.

## Ordem de execução (cada passo termina com testes verdes)

1. **Monorepo** — pnpm workspaces + Turborepo, `tsconfig.base` strict (`noUncheckedIndexedAccess`), ESLint + Prettier, Vitest, `.editorconfig`, `.gitignore`, `git init`. Pacotes vazios com `package.json` apenas onde a Fase 0 os usa: `shared`, `db`, `core`, `ui`, `apps/api`, `apps/worker`.
2. **Infra dev** — `infra/docker/compose.dev.yml`: Postgres 16 (+ `pg_trgm`, `pgvector`), Valkey, MinIO. `.env.example` completo, validado por Zod na subida (falha rápida).
3. **`packages/db`** — Drizzle + drizzle-kit. Tabelas da Fase 0: `accounts`, `users`, `account_users`, `roles`, `role_permissions`, `sessions`, `user_mfa_factors`, `api_keys`, `audit_logs` (append-only via trigger que bloqueia UPDATE/DELETE), `inbound_events`, `outbox`. IDs UUID v7, `timestamptz`. Migração SQL revisável com RLS (`account_id = current_setting('app.account_id')::uuid`). Duas roles no banco: `waychat_owner` (dono/migrações) e `waychat_app` (sem `BYPASSRLS`, não dona). Helper `withTenant(accountId, fn)` que faz `SET LOCAL` na transação.
4. **`packages/shared`** — schemas Zod, tipos de ID, catálogo de permissões, contrato de eventos (`event_id`, `cursor`).
5. **`packages/core` (módulos `identity`, `authz`, `audit`)** — estrutura `domain/application/infra/http`. Argon2id (`@node-rs/argon2`), TOTP (`otplib`) + códigos de recuperação com hash, sessão em cookie `HttpOnly/Secure/SameSite=Lax` com token curto + refresh rotativo com detecção de reuso (revoga a família), bloqueio progressivo de login, resposta que não revela se o e-mail existe. RBAC: Owner/Admin/Supervisor/Agente + papéis customizados.
6. **`apps/api`** — Fastify 5 + `fastify-type-provider-zod`, OpenAPI gerado, headers seguros (CSP com nonce, HSTS etc.), rate limit, CSRF nas rotas com cookie, `/health/live` e `/health/ready`, graceful shutdown. **Toda rota declara `permission`** (ou `public: true` explícito); hook `onRoute` lança erro se faltar — e teste percorre todas as rotas registradas.
7. **`apps/worker`** — BullMQ, relay do outbox (Postgres → Valkey, `FOR UPDATE SKIP LOCKED`), retry exponencial + jitter, DLQ, graceful shutdown. Sem lógica de canal (Fase 2).
8. **Observabilidade** — Pino JSON com `request_id`/`trace_id` e redaction (senhas, tokens, cookies, `content`), OpenTelemetry (HTTP → fila → worker), métricas Prometheus em `/metrics` (interno).
9. **Design system (`packages/ui`)** — `tokens.css` (claro/escuro, todos os tokens da 10A.2), `tailwind-preset.ts`, Plus Jakarta Sans auto-hospedada, componentes base da 10A.8 que não dependem de dados (Button, IconButton, Input, Search, Avatar, Badge, Chip, Accordion, Tooltip, NoteCard, InfoCard, SidebarNavItem, TopNavTab), Storybook nos dois temas, teste de contraste AA. Componentes de conversa (MessageBubble, Composer, AudioWaveform, ConversationListItem) ficam para a Fase 1, onde há a tela que os usa.
10. **Testes de aceite** (Testcontainers, Postgres real): isolamento entre tenants (inclui tentativa de leitura cruzada e de escrita cruzada), login com TOTP, reuso de refresh token revoga a família, `audit_logs` rejeita UPDATE/DELETE, rota sem permissão quebra o teste, outbox não perde nem duplica ao matar o relay no meio.
11. **CI** — GitHub Actions: install com cache, lint, typecheck, test, build, `pnpm audit`, gitleaks, Semgrep, Trivy (imagem). Dependabot.
12. **Docs** — ADRs 0001–0005 (monólito modular, RLS, outbox, sessões/refresh rotativo, licença), `README`, `SECURITY.md`, `docs/backlog.md`.

## Decisões a registrar em ADR

- 0001 Monólito modular em dois processos.
- 0002 RLS com `SET LOCAL` por transação; role de aplicação sem `BYPASSRLS`.
- 0003 Transactional Outbox + relay com `SKIP LOCKED`.
- 0004 Sessão: access token curto + refresh rotativo com detecção de reuso.
- 0005 Licença (ver pergunta 3).

## Riscos

| Risco                                                                                                           | Mitigação                                                                                                   |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Docker daemon não está rodando nesta máquina (só o CLI respondeu) — Testcontainers e `compose up` dependem dele | Iniciar o Docker Desktop antes do passo 2                                                                   |
| RLS esquecida em tabela nova                                                                                    | Teste que lê `pg_class`/`pg_policies` e falha se tabela com `account_id` não tiver RLS habilitada e forçada |
| Pacote nativo do Argon2 no Windows                                                                              | `@node-rs/argon2` traz binário pré-compilado; validar no passo 5                                            |
| Escopo da UI inflar a Fase 0                                                                                    | Apenas componentes sem dados; tela de Conversas fica na Fase 1                                              |

## Fora de escopo da Fase 0 (vai para `docs/backlog.md`)

Passkeys/WebAuthn (o prompt lista em 12.1, mas o aceite da Fase 0 só exige TOTP), verificação HIBP, SSO, inboxes/contatos/conversas, WebSocket, canais.

## Decisões confirmadas

1. Raiz do monorepo: `G:\Way Chat`; `base-sistema/` fica só como referência, fora do workspace.
2. Imagens de referência do design: `imgref/` (copiadas para `docs/design/referencias/`).
3. Licença: AGPL-3.0.
4. Passkeys/WebAuthn: adiadas para a Fase 7 (aceite da Fase 0 exige só TOTP).

## Desvios registrados

- TypeScript fixado em `~6.0` (não 7): `typescript-eslint` ainda não suporta TS 7.
- Portas do host da infra dev: 5462 (Postgres), 6409 (Valkey), 9030/9031 (MinIO) — as padrão já estão ocupadas por outros projetos locais.
- Terceira role no Postgres, `waychat_relay`: o relay do outbox precisa ler todos os tenants; em vez de `BYPASSRLS`, recebe uma policy `TO waychat_relay` e `SELECT` + `UPDATE(published_at)` só na tabela `outbox`.
- `users`, `sessions`, `user_mfa_factors` e `user_recovery_codes` não têm `account_id` (identidade global, o login precisa achá-las antes de saber o tenant) e ficam sem RLS por tenant; será registrado no ADR-0002.
- Busca de `api_keys` por prefixo antes de saber o tenant exige função `SECURITY DEFINER`; fica para a fase que expõe a API pública (`docs/backlog.md`).
- Rotas HTTP ficam em `apps/api/src/routes` (não em `packages/core/.../http`): o núcleo não depende de framework HTTP (ADR 0001).
- CSP da API é `default-src 'none'` sem nonce: a API só devolve JSON. A CSP com nonce fica no painel web (Fase 1).
- Tailwind v4: o "preset" é `packages/ui/src/theme.css` (`@theme`); ver `docs/design/tokens-decisions.md`, com os tokens ajustados para contraste AA.
- Testes de regressão visual (Playwright) da tela de Conversas entram na Fase 1, quando a tela existir.
- `pnpm deploy --legacy` no Dockerfile: evita `inject-workspace-packages`, que copiaria os pacotes em vez de linká-los no desenvolvimento.
- Convite de membros por e-mail depende do canal de e-mail: por ora o admin cria o usuário com senha inicial (`docs/backlog.md`).
