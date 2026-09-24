# Regressão visual

Playwright fotografa, nos temas claro e escuro: o Storybook (`packages/ui`), o widget (`apps/widget`) e a tela de Conversas do painel (`apps/web`). API e Socket.IO são simulados (`page.route` / `page.routeWebSocket`), com UUIDs, datas e relógio fixos.

As linhas de base em `__screenshots__/` valem **só para o container Linux** abaixo (mesma imagem do job `visual` do CI). Rodar no Windows/macOS falha por diferença de fonte, e isso é esperado. O pacote não tem script `test` de propósito: o `turbo run test` não sobe navegador.

## Rodar / regenerar (Docker)

A tag da imagem deve ser a versão do `@playwright/test` (hoje 1.63.0). No Git Bash, na raiz do repositório (`MSYS_NO_PATHCONV=1` evita que o Git Bash reescreva os caminhos do `-v`):

```bash
export MSYS_NO_PATHCONV=1
docker run --rm -v "$(pwd -W):/src:ro" -v "$(pwd -W)/tests/visual/__screenshots__:/out" \
  mcr.microsoft.com/playwright:v1.63.0-noble bash -lc '
    set -e
    mkdir /work && tar -C /src --exclude=node_modules --exclude=dist --exclude=.turbo \
      --exclude=storybook-static --exclude=.git --exclude=test-results -cf - . | tar -C /work -xf -
    cd /work && corepack enable && pnpm install --frozen-lockfile
    pnpm --filter @waychat/ui build-storybook
    pnpm --filter @waychat/widget build
    pnpm --filter @waychat/web build
    pnpm --filter @waychat/visual visual:update   # só verificar: troque por `visual`
    cp -r tests/visual/__screenshots__/. /out/    # só verificar: apague esta linha
  '
```

Revise as imagens alteradas antes de commitar: a linha de base é a aprovação visual. Em falha no CI, o diretório `tests/visual/test-results` (esperado, real e diff) sai como artefato `visual-test-results`.
