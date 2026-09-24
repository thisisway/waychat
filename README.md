# WayChat

Plataforma open source de atendimento omnichannel em tempo real, com foco em entrega confiável de mensagens, segurança e automação. Licença [AGPL-3.0](LICENSE).

> Status: **Fase 0 (fundação)** — autenticação com 2FA, RBAC, isolamento entre tenants por RLS, auditoria, outbox e filas, observabilidade, design system e CI. Canais, painel de atendimento e automações chegam nas próximas fases (veja [WAYCHAT_PROMPT.md](WAYCHAT_PROMPT.md)).

## Estrutura

```
apps/api        Fastify: REST + (Fase 1) WebSocket
apps/web        Painel do atendente (React + Vite + TanStack): login e tela de Conversas
apps/worker     BullMQ: relay do outbox e filas
packages/core   Casos de uso (identidade, RBAC, auditoria, eventos), sem framework HTTP
packages/db     Schema Drizzle, migrações, RLS
packages/shared Contratos (Zod), permissões, logger, telemetria, métricas
packages/ui     Design system: tokens (claro/escuro), Tailwind v4, componentes base, Storybook
infra/docker    Compose de desenvolvimento, Dockerfile de produção
docs            ADRs, planos por fase, OpenAPI, backlog
```

## Rodando em desenvolvimento

Pré-requisitos: Node 22+ (testado no 24), pnpm 11, Docker.

```bash
pnpm install
cp .env.example .env
# gere os dois segredos e cole no .env:
#   MASTER_KEY=$(openssl rand -base64 32)
#   SESSION_SECRET=$(openssl rand -base64 48)
docker compose -f infra/docker/compose.dev.yml --env-file .env up -d --wait   # Postgres, Valkey, MinIO
pnpm build
node --env-file=.env packages/db/dist/migrate-cli.js                          # migrações (como waychat_owner)
node --env-file=.env --import ./apps/api/dist/instrumentation.js apps/api/dist/server.js
node --env-file=.env --import ./apps/worker/dist/instrumentation.js apps/worker/dist/main.js
```

### Ver o painel

```bash
node --env-file=.env apps/api/dist/dev-seed.js        # dados de demonstração (só em desenvolvimento local)
pnpm --filter @waychat/web dev                         # painel em http://localhost:5173
```

Entre com `demo@waychat.dev` (dono) ou `ana@waychat.dev` (agente) e a senha `waychat-teste-2026!`. A senha é pública e fictícia; o comando se recusa a rodar em produção ou fora de localhost. O `PUBLIC_URL` do `.env` precisa ser `http://localhost:5173` (o Vite repassa as rotas da API, então cookies e CSRF funcionam como em produção). O painel recebe as atualizações por WebSocket (com consulta lenta como rede de segurança).

### Testar o widget

```bash
node --env-file=.env apps/api/dist/dev-seed.js         # imprime a data-key da inbox "Site"
pnpm --filter @waychat/widget dev                       # http://localhost:5174/?key=<data-key>
```

Snippet para o site do cliente (o build gera `apps/widget/dist/waychat-widget.js`):

```html
<script src="https://SEU-DOMINIO/waychat-widget.js" data-key="ibx_..." async></script>
```

Opcionais: `data-locale` (`pt-BR`, `en`, `es`), `data-color` e, para usuário logado, `data-user-id` + `data-user-hmac` — o HMAC é `HMAC-SHA256(segredo de identidade, user_id)` em hex, calculado **no servidor do cliente**. O site precisa estar em `allowedOrigins` da inbox.

### Anexos

O bucket é criado sozinho em desenvolvimento (MinIO). Sem antivírus os arquivos passam como limpos; para varrer de verdade:

```bash
docker compose -f infra/docker/compose.dev.yml --env-file .env --profile antivirus up -d --wait   # ClamAV (baixa as assinaturas: demora)
# no .env: CLAMAV_HOST=127.0.0.1
```

Em produção `CLAMAV_HOST` é obrigatório e o bucket precisa aceitar POST (CORS) do painel e dos sites que usam o widget; defina `S3_PUBLIC_ENDPOINT` com o endereço do S3 visto pelo navegador.

As portas do host são `5462` (Postgres), `6409` (Valkey) e `9030/9031` (MinIO) para não colidir com outros projetos locais. A API escuta em `3000`; `/metrics` do Prometheus em `9464` (API) e `9465` (worker), nunca expostas pelo proxy.

## Qualidade

```bash
pnpm lint        # ESLint (strict, type-checked) + Prettier
pnpm typecheck
pnpm test        # Vitest + Testcontainers (Postgres e Valkey reais; precisa de Docker)
pnpm build
pnpm --filter @waychat/ui storybook   # componentes nos temas claro e escuro
```

O OpenAPI é gerado das rotas: `pnpm --filter @waychat/api build && pnpm --filter @waychat/api openapi` grava `docs/api/openapi.json`.

## Segurança em resumo

- Row-Level Security em toda tabela de tenant; a aplicação conecta sem `BYPASSRLS` ([ADR 0002](docs/adr/0002-isolamento-multi-tenant-com-rls.md)).
- Toda rota declara `public`, `self` ou uma permissão; rota sem declaração impede a API de subir.
- Senhas com Argon2id, 2FA TOTP, refresh token rotativo com detecção de reuso ([ADR 0004](docs/adr/0004-sessoes-com-refresh-rotativo.md)).
- Logs com redaction; imagens distroless rodando como não-root.
- Reporte vulnerabilidades conforme [SECURITY.md](SECURITY.md).

## Decisões

[Registros de decisão arquitetural](docs/adr/) · [Planos por fase](docs/plans/) · [Backlog](docs/backlog.md)
