# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).

## [Não lançado]

### Fase 1 — Núcleo de conversas (em andamento)

**Adicionado**

- Tempo real: Socket.IO autenticado pela sessão do painel, com checagem de `Origin`, limite de conexões, presença ("outro atendente está nesta conversa") e indicador de digitação; painel reconecta sozinho e recupera o que perdeu por `GET /sync` (ADR 0007).
- Canal API: `POST /api/v1/messages` com chave Bearer (escopo `messages:write`), idempotente por `external_id`; só escreve em inbox do canal API da própria conta.
- Widget de chat (`apps/widget`): Preact + Shadow DOM, 23,5 KB gzip, pré-chat, identidade por HMAC, pt-BR/en/es, reconexão com recuperação, respostas em tempo real (ADR 0008).
- Anexos no painel e no widget: upload direto ao S3 por formulário assinado (10 MB), tipo conferido pela assinatura do arquivo, varredura ClamAV em fila, download por link de 5 minutos (ADR 0009). Pacote `@waychat/storage`.
- Relay do outbox acordado por `NOTIFY` no COMMIT (polling só como rede de segurança): mensagem do visitante chega ao painel com p95 ≈ 40 ms e a resposta do atendente ao visitante com p95 ≈ 30 ms na cadeia real (Postgres → relay → Valkey → WebSocket), meta de 500 ms.
- `GET /sync`: eventos desde um cursor, com a mesma regra de visibilidade do WebSocket.

### Fase 0 — Fundação

**Adicionado**

- Monorepo pnpm + Turborepo, TypeScript strict, ESLint, Prettier, Vitest.
- `packages/db`: schema (contas, usuários, papéis, sessões, MFA, chaves de API, auditoria, eventos de entrada, outbox), migrações, RLS forçada com testes de isolamento entre tenants, auditoria append-only.
- `packages/core`: registro de conta, login com bloqueio progressivo, TOTP + códigos de recuperação, sessões com refresh rotativo e detecção de reuso, RBAC com papéis de sistema e customizados, anti-escalada de privilégio, proteção do último Owner, auditoria, cifragem AES-256-GCM com rotação de chave.
- `apps/api`: Fastify com validação Zod, OpenAPI, cookies HttpOnly, CSRF, rate limit, cabeçalhos de segurança, CORS restrito, health checks, métricas Prometheus e trava que impede rotas sem declaração de acesso.
- `apps/worker`: relay do Transactional Outbox (`SKIP LOCKED`, at-least-once), filas BullMQ com backoff exponencial + jitter e dead-letter queue.
- Observabilidade: logs JSON com redaction e `trace_id`, OpenTelemetry com o trace continuando pelo outbox até o worker, métricas em porta separada.
- Infra: Docker Compose de desenvolvimento (Postgres 16 + pgvector, Valkey, MinIO), Dockerfile distroless não-root.
- CI (GitHub Actions): lint, tipos, build, testes, `pnpm audit`, gitleaks, Semgrep, Trivy; Dependabot.
- `packages/ui`: tokens de cor/forma/movimento nos temas claro e escuro, Tailwind v4, Plus Jakarta Sans auto-hospedada, 13 componentes base acessíveis, Storybook com os dois temas e teste de contraste WCAG AA (78 verificações).
- ADRs 0001–0005, `SECURITY.md`.
