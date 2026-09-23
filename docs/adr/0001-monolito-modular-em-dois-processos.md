# 0001 — Monólito modular em dois processos

- Status: aceito
- Fase: 0

## Contexto

O WayChat precisa rodar em um servidor pequeno (2 vCPU / 4 GB para ~50 atendentes) e escalar horizontalmente depois. Microsserviços trariam custo operacional (rede, deploy, observabilidade por serviço) que o produto ainda não justifica.

## Decisão

Um único código de backend, dividido em módulos de domínio (`packages/core/src/modules/*`, cada um com `domain/`, `application/`, `infra/`), executado em **dois processos**:

- `apps/api` — HTTP (Fastify) e, na Fase 1, WebSocket;
- `apps/worker` — relay do outbox e filas (BullMQ).

`packages/core` não conhece HTTP: os casos de uso recebem `ctx` e o `actor` e devolvem dados ou `DomainError`. As rotas ficam em `apps/api` e são finas (validam com Zod, chamam o caso de uso, traduzem o erro). O papel de `http/` citado no prompt original é cumprido por `apps/api/src/routes`, para o núcleo não depender do Fastify.

Cada canal futuro implementa `ChannelAdapter`; o núcleo nunca conhece detalhes de um canal.

## Consequências

- Um deploy, uma versão, refatorações atravessam módulos sem contrato de rede.
- A fronteira entre módulos é convenção (imports), não isolamento físico; revisar em PR. Se um módulo precisar escalar sozinho, ele já está isolado atrás de casos de uso e pode virar serviço.
